"""
Caption every extracted figure with a vision model, once, offline. Commit the result.

This file is why figure retrieval works without embeddings. Each caption is written
to be *searchable prose about what the figure answers*, and the whole catalogue then
lives in the agent's cached system prompt -- so the agent picks a figure by reading a
complete list, never by ranking one. Recall is 1.0 by construction.

Dry run by default; nothing is spent until you pass --go. Results are cached per
figure, so a re-run only pays for figures that are new or previously failed.

    python ingest/caption.py            # plan + cost estimate, spends nothing
    python ingest/caption.py --go       # actually caption
"""
from __future__ import annotations

import base64
import io
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "knowledge"
CAPTIONS = KB / "captions.json"

# Whole-page figures and the standalone documents carry the densest, most
# consequential content (the process selection chart, the weld-diagnosis grid,
# the wiring schematic). They get the stronger model; everything else does not.
HARD_AREA = 0.40
CHEAP, STRONG = "claude-haiku-4-5", "claude-opus-5"
PRICES = {  # USD per 1M tokens, (input, output)
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-opus-5": (5.0, 25.0),
}
MAX_EDGE = 1568  # the API downscales past this anyway; sending more just costs money

# Escalation rule. A cheap caption that turned out to describe polarity is re-done on
# the strong model, because these figures encode which cable goes in which socket as
# an *icon* -- a minus sign above a clamp glyph -- and the cheap model inverted one of
# them (p32-f6: it read the clamp as the electrode holder). Getting polarity backwards
# on a 240V machine is the worst error this system can make, so it does not ride on
# the cheap model. Facts still come from tables.json; captions only choose the picture.
SAFETY_TERMS = ("polarit", "dcep", "dcen", "positive", "negative", "socket", "terminal")

PROMPT = """You are cataloguing figures from the Vulcan OmniPro 220 welder manual so \
that a support agent can decide, from your description alone, whether this exact image \
answers a user's question.

Page {page} of {doc} reads:
<page_text>
{text}
</page_text>

Text detected inside the figure's own region: {labels}

Return ONLY a JSON object:
{{
 "title": "short noun phrase naming the figure",
 "kind": "photo|screen|diagram|schematic|chart|table|decorative",
 "summary": "1-3 sentences: what it depicts, and what a user question it settles",
 "visible_text": ["each distinct text string legible in the image"],
 "shows": ["searchable keywords: components, processes, symbols, settings"],
 "answers": ["plain-language questions this figure answers, e.g. 'which socket does \
the ground clamp go in for flux-cored'"]
}}

Rules:
- "decorative" is for logos, page furniture, safety pictograms, arrows and fragments \
that carry no information a user would ask about. Be strict: a cropped sliver of a \
larger picture is decorative.
- If the figure encodes a setting, a polarity, a value or a decision, say the actual \
value in the summary. Do not write "shows the settings" -- write which settings.
- Transcribe tables and decision matrices in full inside visible_text.
"""

_lock = threading.Lock()
_spend = {"in": 0, "out": 0, "usd": 0.0}


def api_key() -> str:
    m = re.search(r"^ANTHROPIC_API_KEY=(\S+)", (ROOT / ".env").read_text(encoding="utf-8"), re.M)
    if not m or m.group(1) == "your-api-key-here":
        sys.exit("Set ANTHROPIC_API_KEY in .env first.")
    return m.group(1)


def encoded(path: Path) -> str:
    im = Image.open(path)
    if max(im.size) > MAX_EDGE:
        r = MAX_EDGE / max(im.size)
        im = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))), Image.LANCZOS)
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "WEBP", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def caption_one(client: anthropic.Anthropic, fig: dict, page_text: str) -> dict:
    model = STRONG if (fig["area_frac"] >= HARD_AREA or fig["doc"] != "manual") else CHEAP
    msg = client.messages.create(
        model=model,
        # A dense decision matrix transcribed in full runs long; truncation returns
        # invalid JSON and loses the figure entirely, which is how the process
        # selection chart failed on the first pass.
        max_tokens=8000 if model == STRONG else 2000,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/webp",
                                         "data": encoded(KB / "figures" / f"{fig['id']}.webp")}},
            {"type": "text", "text": PROMPT.format(
                page=fig["page"], doc=fig["doc"],
                text=page_text[:4000], labels=fig["labels"] or "(none)")},
        ]}],
    )
    pin, pout = PRICES[model]
    with _lock:
        _spend["in"] += msg.usage.input_tokens
        _spend["out"] += msg.usage.output_tokens
        _spend["usd"] += msg.usage.input_tokens / 1e6 * pin + msg.usage.output_tokens / 1e6 * pout

    raw = "".join(b.text for b in msg.content if b.type == "text")
    body = re.search(r"\{.*\}", raw, re.S)
    if not body:
        raise ValueError(f"no JSON from {model} for {fig['id']}")
    out = json.loads(body.group(0))
    out["model"] = model
    return out


def main() -> None:
    figs = json.loads((KB / "figures.json").read_text(encoding="utf-8"))
    pages = {(p["doc"], p["page"]): p["text"]
             for p in json.loads((KB / "pages.json").read_text(encoding="utf-8"))}
    done = json.loads(CAPTIONS.read_text(encoding="utf-8")) if CAPTIONS.exists() else {}
    todo = [f for f in figs if f["id"] not in done or "error" in done[f["id"]]]
    escalate = [f for f in figs if f["id"] in done
                and done[f["id"]].get("model") == CHEAP
                and any(t in json.dumps(done[f["id"]]).lower() for t in SAFETY_TERMS)]
    for f in escalate:
        f["area_frac"] = 1.0  # force the strong model on the re-run
    todo += escalate

    strong = [f for f in todo if f["area_frac"] >= HARD_AREA or f["doc"] != "manual"]
    # ~1.3k image tokens + ~1.1k page-text tokens in, ~450 out, measured on this corpus.
    est = (len(strong) * (2400 / 1e6 * 5.0 + 450 / 1e6 * 25.0)
           + (len(todo) - len(strong)) * (2400 / 1e6 * 1.0 + 450 / 1e6 * 5.0))
    print(f"cached  {len(done)}")
    print(f"escalated {len(escalate)}  (cheap captions touching polarity/socket wording)")
    print(f"to do   {len(todo)}  ({len(strong)} on {STRONG}, {len(todo) - len(strong)} on {CHEAP})")
    print(f"est.    ${est:.2f}")
    if "--go" not in sys.argv:
        print("\ndry run -- nothing spent. re-run with --go to caption.")
        return
    if not todo:
        return

    client = anthropic.Anthropic(api_key=api_key())

    def run(f: dict) -> None:
        try:
            cap = caption_one(client, f, pages[(f["doc"], f["page"])])
        except Exception as e:  # one bad figure must not lose the whole batch
            cap = {"error": str(e)[:200]}
        with _lock:
            done[f["id"]] = cap
            n = len(done)
            if n % 10 == 0:
                print(f"  {n}/{len(figs)}  ${_spend['usd']:.2f}")
                CAPTIONS.write_text(json.dumps(done, indent=1), encoding="utf-8")

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(run, todo))

    CAPTIONS.write_text(json.dumps(done, indent=1), encoding="utf-8")
    bad = [k for k, v in done.items() if "error" in v]
    kinds: dict[str, int] = {}
    for v in done.values():
        kinds[v.get("kind", "?")] = kinds.get(v.get("kind", "?"), 0) + 1
    print(f"\ncaptioned {len(done)}  failed {len(bad)}")
    print(f"kinds     {kinds}")
    print(f"spend     ${_spend['usd']:.4f}  ({_spend['in']:,} in / {_spend['out']:,} out)")


if __name__ == "__main__":
    main()
