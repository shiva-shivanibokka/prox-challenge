"""
Turn the manual's load-bearing tables into structured data, once, offline.

Text extraction alone is not enough here. On page 7 the specification table's columns
interleave in reading order --

    Power Input / 120 VAC 60Hz / 240 VAC 60Hz / ... / 40% @ 100 A / 100% @ 75 A
    / 25% @ 200 A / 100% @ 115 A

-- so which duty cycle belongs to which input voltage is genuinely ambiguous in the
text layer. A model reading the rendered page recovers the column structure; a
deterministic check then refuses any number that does not literally appear in that
page's own text. Extraction can be wrong; verification cannot be persuaded.

These tables, not the figure captions, are what the agent cites for facts. A caption
exists to choose a picture. That split matters: the first captioning pass inverted the
polarity on one LCD screen, and a wrong socket on a 240V machine is the worst error
this system can make.

    python ingest/tables.py                 # plan only, spends nothing
    python ingest/tables.py --go            # build all
    python ingest/tables.py polarity --go   # rebuild one
"""
from __future__ import annotations

import base64
import io
import json
import re
import sys
from pathlib import Path

import anthropic
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "knowledge"
MODEL = "claude-opus-5"

SPECS_SCHEMA = """{"processes":[{"process":"MIG|TIG|Stick","input_volts":120|240,
"current_input_a":number,"at_output_a":number,"current_range_a":[min,max],
"duty_cycles":[{"percent":number,"amps":number}],"max_ocv_vdc":number,
"materials":[string]}],"wire":{"solid_core_in":[string],"flux_cored_in":[string],
"speed_ipm":[min,max],"spool_capacity_lb":number}}"""

POLARITY_SCHEMA = """{"setups":[{"process":"MIG|Flux-Cored|TIG|Stick",
"polarity":"DCEP|DCEN","hot_lead":"what plugs into the live socket",
"hot_lead_socket":"+|-","ground_clamp_socket":"+|-","shielding_gas":string|null,
"note":string,"sources":[string]}]}"""

TROUBLE_SCHEMA = """{"problems":[{"problem":string,"page":number,
"causes":[{"cause":string,"solution":string}]}]}"""

SELECTION_SCHEMA = """{"processes":[{"process":string,"skill_level":string,
"shielding_gas":string,"materials":[string],"thickness":string,
"applications":[string],"cleanliness":string,"strengths":[string]}]}"""

TABLES = [
    ("specs", [("manual", 7)], SPECS_SCHEMA,
     "The Specifications table. One entry per process per input voltage -- six in all. "
     "Read the columns off the rendered page; the text layer interleaves them."),

    # The authoritative polarity sources are manual p13 (DCEN flux-cored), p14 (DCEP
    # solid core), p27 (stick) and quick-start p2, which is the only page covering all
    # four processes. Manual p43 merely restates the MIG/flux rule in passing.
    ("polarity", [("manual", 13), ("manual", 14), ("manual", 27),
                  ("manual", 32), ("quickstart", 2)], POLARITY_SCHEMA,
     "Cable polarity per welding process: MIG, Flux-Cored, TIG and Stick. Read the "
     "sockets off the rendered diagrams. In sources cite where you read each row, as "
     "'manual:14' or 'quickstart:2'. Omit any process no source states -- never infer "
     "from general welding knowledge."),

    ("troubleshooting", [("manual", 42), ("manual", 43), ("manual", 44)], TROUBLE_SCHEMA,
     "The full troubleshooting matrix. Every problem row, every cause, every solution. "
     "Pages 42 and 44 belong to different sections and may repeat a problem name; keep "
     "both and let the page number distinguish them."),

    ("process_selection", [("chart", 1)], SELECTION_SCHEMA,
     "The six-question welding process selection chart."),
]


def api_key() -> str:
    m = re.search(r"^ANTHROPIC_API_KEY=(\S+)", (ROOT / ".env").read_text(encoding="utf-8"), re.M)
    if not m or m.group(1) == "your-api-key-here":
        sys.exit("Set ANTHROPIC_API_KEY in .env first.")
    return m.group(1)


def page_image(doc: str, page: int) -> dict:
    im = Image.open(KB / "pages" / f"{doc}-p{page:02d}.webp")
    if max(im.size) > 1568:
        r = 1568 / max(im.size)
        im = im.resize((int(im.width * r), int(im.height * r)), Image.LANCZOS)
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "WEBP", quality=88)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/webp",
                                        "data": base64.b64encode(buf.getvalue()).decode()}}


def numbers(obj) -> list[str]:
    """Every numeric literal appearing anywhere in the extracted structure."""
    out: list[str] = []
    if isinstance(obj, dict):
        for v in obj.values():
            out += numbers(v)
    elif isinstance(obj, list):
        for v in obj:
            out += numbers(v)
    elif isinstance(obj, bool):
        pass
    elif isinstance(obj, (int, float)):
        out.append(f"{obj:g}")
    elif isinstance(obj, str):
        out += re.findall(r"\d+(?:\.\d+)?", obj)
    return out


def main() -> None:
    only = {a for a in sys.argv[1:] if not a.startswith("--")}
    pages = {(p["doc"], p["page"]): p["text"]
             for p in json.loads((KB / "pages.json").read_text(encoding="utf-8"))}
    caps = json.loads((KB / "captions.json").read_text(encoding="utf-8"))
    prior = json.loads((KB / "tables.json").read_text(encoding="utf-8")) \
        if (KB / "tables.json").exists() else {}

    todo = [t for t in TABLES if not only or t[0] in only]
    print(f"{len(todo)} tables, {sum(len(t[1]) for t in todo)} page images on {MODEL}")
    print(f"est.    ${0.08 * len(todo):.2f}")
    if "--go" not in sys.argv:
        print("\ndry run -- nothing spent. re-run with --go.")
        return

    client = anthropic.Anthropic(api_key=api_key())
    out, spend, failures = dict(prior), 0.0, []
    nl = "\n"

    for name, srcs, schema, hint in todo:
        src = (nl * 2).join(f"[{d} page {n}]{nl}{pages[(d, n)]}" for d, n in srcs)
        # A page whose content is purely graphical contributes no text to verify
        # against, so its verification corpus is the vision transcription instead.
        for d, n in srcs:
            if len(pages[(d, n)]) < 400:
                src += nl + nl.join(
                    t for k, v in caps.items()
                    if k.startswith(f"{d}-p{n:02d}") and v.get("kind") != "decorative"
                    for t in v.get("visible_text", []))

        content = [page_image(d, n) for d, n in srcs]
        content.append({"type": "text", "text":
            f"{hint}{nl * 2}Source text:{nl}<pages>{nl}{src}{nl}</pages>{nl * 2}"
            f"Return ONLY JSON matching:{nl}{schema}{nl * 2}"
            "Every number must be one that actually appears in the sources. Never "
            "round, never infer, never fill a gap from general welding knowledge."})

        msg = client.messages.create(model=MODEL, max_tokens=8000,
                                     messages=[{"role": "user", "content": content}])
        spend += msg.usage.input_tokens / 1e6 * 5 + msg.usage.output_tokens / 1e6 * 25
        raw = "".join(b.text for b in msg.content if b.type == "text")
        body = re.search(r"\{.*\}", raw, re.S)
        if not body:
            failures.append(f"{name}: no JSON returned")
            continue
        data = json.loads(body.group(0))

        # Deterministic gate: every number must be present in the source text.
        seen = set(re.findall(r"\d+(?:\.\d+)?", re.sub(r"[^\d.]", " ", src)))
        missing = sorted({n for n in numbers(data) if n not in seen})
        if missing:
            failures.append(f"{name}: {len(missing)} unverified: {missing[:12]}")
        out[name] = {"sources": [f"{d}:{n}" for d, n in srcs], "data": data,
                     "unverified_numbers": missing}
        print(f"  {name:18} {len(json.dumps(data)):>6} bytes  "
              f"{'OK' if not missing else str(len(missing)) + ' UNVERIFIED'}")

    (KB / "tables.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nspend  ${spend:.3f}")
    for f in failures:
        print(f"  !! {f}")


if __name__ == "__main__":
    main()
