# OmniPro 220 — a technical product expert

A multimodal agent that answers deep questions about the Vulcan OmniPro 220 welder,
built on the Claude Agent SDK. It cites the page, shows the figure, computes duty
cycle deterministically, and refuses when the manuals don't cover something.

```bash
git clone https://github.com/shiva-shivanibokka/prox-challenge
cd prox-challenge
cp .env.example .env          # paste your ANTHROPIC_API_KEY
npm install
npm run dev                   # http://localhost:3000
```

No PDF parsing at startup, no index to build, no second API key, no vector database.
The knowledge index is committed to the repo.

---

## The actual problem

The three PDFs in `files/` are not a text corpus with some pictures in it. Before
writing anything I profiled them:

| File | Pages | Text layer | What's really there |
|---|---|---|---|
| `owner-manual.pdf` | 48 | Clean | Prose and tables fine. **Figures are vector art** — `get_images()` returns 0 on most figure pages, while `get_drawings()` returns thousands of primitives (p.47 has 26,144) |
| `quick-start-guide.pdf` | 2 | ~570 chars total | Effectively pure diagram — and the only source that covers cable setup for all four processes |
| `selection-chart.pdf` | 1 | **Zero characters** | The welding process selection chart. Invisible to every text pipeline |

Three consequences drove the whole design:

**Figure extraction must render page regions, not extract embedded images.** A
pipeline built on `get_images()` or `pdfimages` silently returns almost nothing here.
That is the trap in this challenge.

**The most important single image has no text at all.** The selection chart is a
six-question decision matrix that answers "which process should I use" — the exact
question a first-time owner asks — and a text-only pipeline cannot see it.

**Polarity lives in pictures.** On p.20 the polarity setting is an *icon* on an LCD
screenshot: a ground-clamp glyph under `−`, a torch glyph under `+`. The extracted
text says nothing about which socket.

---

## How the knowledge index is built

`ingest/` runs offline. You never run it; its output is committed under `public/kb/`.
This is what makes setup two minutes and what stops anyone paying to rebuild it.

### 1. `extract.py` — text, figures, page images

Figures are found by rasterising every vector primitive and raster rect into a coarse
occupancy grid, dilating, and taking connected components. Those regions are then
rendered at 200 DPI and cropped. Along the way:

- **Page chrome is detected by repetition.** The section tabs down the page edge shift
  and re-highlight per page, so their bounding boxes never repeat exactly and a
  naive frequency filter misses them. Their *x-band* is rock steady, so that is what
  gets detected — columns inked on ≥70% of pages are chrome, not content. Guarded to
  only run on documents with enough pages: on a 1-page PDF every column trivially
  looks like chrome, which silently dropped the entire selection chart on the first
  run.
- **Labels are absorbed, paragraphs are not.** A crop without its callouts ("Power
  Switch", "Left Knob") is useless, but a neighbouring paragraph must not drag the
  crop across the page — so growth is capped at 1.6× the region's area.
- **Repeated boilerplate is stripped from the text.** The same ten lines of header and
  footer on 48 pages is pure noise in the model's context.

Result: 51 pages, 128 figures, 12 MB of WebP, 22k tokens of text.

### 2. `caption.py` — one vision pass per figure

Each figure gets a caption written specifically to answer *"is this the image that
settles the user's question?"* — a title, a kind, a summary, transcribed visible text,
and a list of plain-language questions it answers. Whole-page and complex figures go
to Opus 5; the rest to Haiku 4.5. Cached per figure, so a re-run costs nothing.

The selection chart came back as **54 transcribed rows** of its decision matrix.
Content that exists nowhere in any text layer is now first-class searchable data.

**A safety escalation rule exists because the cheap model got polarity backwards.**
Haiku captioned the Stick LCD screen as "negative connects to the electrode holder,
positive to the workpiece clamp" — the exact inverse of what the pixels show. Any
cheap caption mentioning polarity, sockets or terminals is now automatically re-run on
the strong model. A wrong socket on a 240V machine is the worst error this system can
make, so it does not ride on the cheap model.

That incident also fixed the architecture: **captions choose the picture, tables state
the fact.** The agent is instructed never to source a polarity claim from a caption.

### 3. `tables.py` — four structured tables, verified

Text extraction is not enough for the specification table. On page 7 the columns
interleave in reading order:

```
Power Input / 120 VAC 60Hz / 240 VAC 60Hz / … / 40% @ 100 A / 100% @ 75 A
  / 25% @ 200 A / 100% @ 115 A
```

Which duty cycle belongs to which input voltage is genuinely ambiguous in the text
layer — and this is precisely the question being graded. A model reading the *rendered*
page recovers the column structure.

Extraction can be wrong, so it is gated: **every numeric literal in an extracted table
must appear in the source page's own text**, or the build reports it as unverified.
All four tables pass clean.

The polarity table was rebuilt once. The first pass cited p.43, which only restates
the MIG/flux rule in passing; the authoritative sources are p.13 (DCEN flux-cored),
p.14 (DCEP solid core), p.27 (stick) and quick-start p.2 — the only page covering all
four processes. Citations matter here: the promise is that you can walk to the machine
and check.

---

## Why there is no vector store

This is the decision I most expect to be asked about.

The whole corpus is **51 pages ≈ 22k tokens of text**. The figure catalogue is another
11k. That fits in a prompt-cached system prompt for about **$0.16 per conversation**,
so I deleted the retrieval layer entirely:

- **All manual text sits in the cached prefix**, every page tagged `[manual page 23]`.
  Cross-referencing p.43's porosity row against p.13's polarity diagram stops being a
  recall problem. Top-k retrieval is where cross-referenced questions go to die.
- **A catalogue of every figure sits in the prefix too** — id, page, title, and the
  questions each figure answers. The model doesn't *search* for a figure; it reads a
  complete list and asks for one by id. **Recall is 1.0 by construction**, not 0.8.
- **Only the images themselves are fetched by tool**, because 128 images cannot live
  in context.

Two supporting reasons:

**Embeddings would need a second vendor.** Anthropic has no embedding endpoint;
Voyage or OpenAI would break the "single API key in `.env`" requirement.

**CLIP was already ruled out by measurement.** In prior work on a multimodal RAG
system I benchmarked CLIP cross-modal retrieval against a much simpler OCR-caption
baseline and CLIP lost badly — recall@5 of 0.43 against 0.80. Caption-text retrieval
beats joint-embedding retrieval on document figures. This design takes that one step
further: at this corpus size you can skip ranking altogether.

**The catalogue encoding was tuned.** Full captions as JSON cost 25k tokens. Encoding
one line per figure carrying only the title and the questions it answers costs 11k
with no loss of selection signal — the *answers* are what the model matches a user's
wording against; the *summary* is payload and rides along with the image when the
figure is fetched.

**When I'd change this:** past roughly 150 pages, or a multi-product corpus, the prefix
stops being cheap and BM25 over the same catalogue goes back in. The index is already
shaped for it — that's a ~30-line change, not a rewrite. Building a vector database
for 51 pages would be the wrong instinct to bring to a small team.

---

## The agent

Six tools over the Agent SDK's in-process MCP transport (`createSdkMcpServer`). The
built-in Claude Code tools are disabled by name — no Bash, no filesystem, no web. The
agent's entire world is the committed index.

| Tool | Returns |
|---|---|
| `get_figure` | the actual image bytes plus caption and page |
| `get_page` | a whole page image plus its text |
| `get_table` | verified structured data |
| `compute_duty_cycle` | deterministic lookup; allowed to say "not specified" |
| `show_component` | renders one of four table-driven React components |
| `render_diagram` | renders model-authored SVG |

### Deterministic where correctness matters, generative where it doesn't

`show_component` and `render_diagram` are two halves of the same job, split
deliberately. The four components — duty cycle calculator, polarity diagram,
troubleshooting flowchart, process selector — read the **verified tables**, not
anything the model produced. The agent picks which one to show and seeds its starting
values; it never supplies content. So what a user pokes at cannot drift from the
manual.

I am not letting a model free-draw which cable goes in which socket on a 240V machine.
`render_diagram` exists for the long tail where being approximately right is fine.

### Duty cycle never interpolates

The manual publishes exactly two rated points per process per voltage — for MIG on
240V, 25% @ 200A and 100% @ 115A. It does not publish a curve, and duty cycle is not
linear in current. So `compute_duty_cycle` returns the rated point when the question
lands on one, "100% continuous" at or below the continuous rating, and an explicit
*"the manual does not specify"* with the bracketing points otherwise. Inventing a duty
cycle for a welder is how someone cooks the machine.

---

## Verification: two levels, no model call

Telling a model not to invent numbers is not a control. After every answer, a
deterministic pass (~1ms, no API call) extracts every quantity carrying a unit — amps,
volts, percentages, wire speeds, gauges, minutes — and checks it:

- **fabricated** — appears nowhere in any of the three documents nor in any tool result
  from this turn. The dangerous one.
- **miscited** — real, but not on the page the answer pointed at. Harmless to act on,
  still shown, because the whole promise is that you can verify at the machine.

The UI shows the verdict under every answer. This is the cheap, dependency-free
descendant of an NLI faithfulness gate: it can't judge entailment, but it catches the
failure that actually matters on a welder.

**It caught a real one during development.** The agent sourced a 1/2" contact-tip-to-work
distance to p.37 when the manual prints it on p.35 — a genuine citation slip I would
not have found by reading the answer, which looked perfect.

---

## Evals

```bash
npm run dev
npm run eval            # or: npm run eval -- duty-cycle polarity-flux
```

Five cases, each asserting what a correct answer must contain — content, tools called,
a visual where one is required, the page cited, and no fabricated quantities.

| Case | Tests |
|---|---|
| `duty-cycle` | the headline number, computed not guessed |
| `porosity` | diagnosis from the troubleshooting matrix, with the weld photo |
| `polarity-flux` | a picture, not a paragraph |
| `refusal-generator` | refusing cleanly on something never covered |
| `cross-reference` | 120V duty cycle *and* flux-cored polarity in one answer |

**5/5 pass, ~$0.36 per full run.**

The refusal case is the one I'd point at. "Can I run this off a portable generator?" —
the word *generator* appears zero times across all three documents. The agent says so,
declines to name a wattage, then hands over the actual current-draw table from p.7 so
you can size one yourself, explicitly noting *"that's current draw, not a generator
wattage rating."* Useful and honest at the same time.

---

## What it costs

Measured, not estimated.

- **Cached prefix:** ~37k tokens of index, plus ~20–27k of fixed Agent SDK harness
  prompt. That harness overhead is unavoidable — `tools: []` does not remove it — and
  is worth knowing about before you design around the SDK.
- **Per question:** $0.02–0.06 warm, ~$0.18 on a cold cache.
- **Full eval run:** ~$0.36.
- **Building the entire index, once:** ~$2.50.

Defaults to `claude-sonnet-5`. Set `MODEL=claude-opus-5` in `.env` for more headroom.
Sonnet is the default deliberately: the architecture removes the work that would need
a bigger model. Recall is handled by the prefix, arithmetic by a tool, figure choice by
an exhaustive catalogue, facts by verified tables. What's left is instruction-following
and tone. Reaching for Opus here would be paying a model to compensate for an index I
didn't build properly.

---

## Design notes worth defending

**Stateless requests.** Each turn replays the transcript rather than resuming an SDK
session. Sessions persist to the harness's home directory, which on Vercel is a
per-instance `/tmp` the next request may not land on. Replaying is free because the
prefix is identical and cached.

**Runs on Vercel, verified before anything else was built.** The Agent SDK resolves a
~219 MB per-platform native binary and spawns it as a subprocess. Next's file tracer
never sees it — it's resolved at runtime, not imported — so `next.config.ts` pins it
via `outputFileTracingIncludes`. I deployed a probe endpoint first to confirm the
harness boots on Fluid Compute before committing to the platform.

**Two languages, one runtime.** Ingest is Python because nothing else handles vector
figure geometry as well. The shipped app is TypeScript only; a reviewer never runs
Python. The index is a versioned build artifact, like a compiled asset.

**A markdown subset, not a markdown library.** ~40 lines covering paragraphs, lists,
headings, bold, code and pipe tables. It also lets every `[p.14]` become a button that
opens that page image — citations are controls here, not footnotes.

## Interface

Two visual registers that never mix. Answers are *paper*: serif, narrow measure, on a
galvanized-grey ground, like the manual in your other hand. Machine-derived data —
duty cycle readouts, polarity sockets — renders as *panel*: white-on-near-black boxed
values, the way the machine's own LCD shows them. Colour is never decoration: orange
means electrically hot, amber unverified, green checked.

## Repo map

```
ingest/          offline, dev-only. You never run these.
  extract.py       text, figure regions, page renders
  caption.py       one vision caption per figure, cached
  tables.py        four structured tables + numeric verification
public/kb/       the committed index (JSON + WebP), served by CDN
lib/
  kb.ts            loads the index, builds the cached system prompt
  tools.ts         the six agent tools
  duty.ts          deterministic duty cycle, shared with the browser
  verify.ts        post-answer grounding check
app/
  api/chat/route.ts   the agent, streaming SSE
  components/         chat UI and the four interactive components
evals/run.mjs    five cases with assertions
```

## Limits

- Conversation history is text-only; figures from earlier turns aren't re-sent as
  images on later turns.
- The verifier checks quantities, not claims. "Use argon" would pass unexamined.
- Figure crops on two dense pages still include the section-tab margin.
- One eval case reproducibly warns about a miscitation rather than failing. That is
  the intended behaviour, not a green test bought by lowering the bar.
