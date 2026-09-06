# OmniPro 220 — a technical expert for one welder

Ask questions about the Vulcan OmniPro 220 and get answers that cite the page, show the
figure, and refuse when the manual doesn't cover it. Built on the Claude Agent SDK.

**You can also show it your weld.** Take a photo of your bead and it compares yours
against the manual's own diagnosis chart, tells you what to change — or tells you the
weld is fine.

```bash
git clone https://github.com/shiva-shivanibokka/prox-challenge
cd prox-challenge
cp .env.example .env          # paste your ANTHROPIC_API_KEY
npm install
npm run dev                   # http://localhost:3000
```

Nothing is extracted at startup. No index to build, no second API key, no database.

**Live demo:** https://omnipro-220-expert.vercel.app — it asks for your own Anthropic
key, because a public URL wired to my key would spend my money. The key is held in
memory for that browser tab only: no cookie, no localStorage, no server storage. A
refresh loses it. The interactive panel on the landing page works without any key.

---

## The problem, in one paragraph

Prox said they'd test three questions: duty cycle, porosity, polarity. **None of those
answers exist as sentences in the manual.** A duty cycle is a grid of numbers. Polarity
is a picture — on page 20 it's an *icon*, a drawing of a clamp under a minus sign, with
no words at all. Porosity is a photo you compare your weld against.

So the obvious approach — chop the manual into text chunks, search the text, feed the
best chunks to a model — quietly fails on exactly the questions being graded. It
wouldn't error. It would give a confident, plausible, wrong answer. On a machine running
mains voltage and compressed gas, that's the worst possible failure.

Everything below follows from that.

---

## What I found before writing any code

I profiled the files first. This changed the whole design.

| File | Pages | Text? | What's really in it |
|---|---|---|---|
| `owner-manual.pdf` | 48 | Yes, clean | Prose and tables fine. But **the figures are vector drawings, not images** |
| `quick-start-guide.pdf` | 2 | ~570 characters | Basically all diagram — and the only place all four processes' cable setups appear |
| `selection-chart.pdf` | 1 | **Zero characters** | The "how to choose a process" chart. Completely invisible to text tools |
| `product-inside.webp` | — | It's a photo | The Settings Chart inside the welder door. The manual points readers to it **five times** — and it isn't even in `files/` |

Three things follow:

**1. You can't extract the figures the normal way.** They're drawn as thousands of tiny
vector lines, not stored as pictures. Ask a PDF library for the embedded images on
page 47 and you get **zero**. Ask for the drawings and you get **26,144**. Any pipeline
built the usual way returns almost nothing here — and fails silently.

**2. The most important chart has no text at all.** The process selection chart answers
"which welding process should I use", which is the first thing a new owner asks. A
text-only system cannot see it.

**3. Polarity lives in pictures.** Which cable goes in which socket is shown as icons on
an LCD screenshot.

---

## How the knowledge gets built

Everything in `ingest/` runs **once, on my machine, offline**. You never run it. The
results are committed to the repo. That's why setup takes two minutes and why nobody
pays to rebuild it.

### Step 1 — `extract.py`: pull out text, figures and page images

Since figures are vector art, they're found by drawing every vector shape onto a coarse
grid, joining up the blobs that touch, and screenshotting those regions of the page at
high resolution.

A few details that mattered:

- **Page furniture gets removed by spotting repetition.** The section tabs down the edge
  of every page shift and re-highlight, so their exact position never repeats — but their
  *column* does. Columns that are inked on nearly every page are chrome, not content.
  This needed a guard: on a one-page PDF, every column trivially looks like chrome, which
  silently deleted the entire selection chart the first time I ran it.
- **Labels come along, paragraphs don't.** A crop without its callouts ("Power Switch",
  "Left Knob") is useless, but a nearby paragraph mustn't drag the crop across the page.
  So a region can grow by at most 1.6× while collecting labels.
- **Repeated headers and footers are stripped** — the same ten lines on 48 pages is pure
  noise in the model's context.

Result: **52 pages, 134 figures, 13 MB of images, about 22,000 tokens of text.**

### Step 2 — `caption.py`: describe every figure once

Each figure gets a written description from a vision model — what it shows, what text is
visible in it, and **the plain-language questions it answers**. Cached per figure, so
re-running costs nothing. The selection chart came back as **54 transcribed rows** of its
decision matrix: content that exists nowhere in any text layer is now searchable data.

**One thing went wrong here, and fixing it shaped the architecture.** The cheap model
captioned the Stick polarity screen backwards — it read the ground-clamp icon as the
electrode holder, the exact opposite of what the pixels show. Getting polarity wrong on a
240V machine is the worst mistake this system could make.

Two changes came out of that:

- Any cheap caption that mentions polarity, sockets or terminals is **automatically
  redone on the stronger model**.
- More importantly: **captions choose which picture to show. Tables state the facts.**
  The agent is told never to source a polarity claim from a caption.

The door Settings Chart proved the same point again. It's a photograph, and the vision
pass misread a digit — reporting Stick at 40% at **65A** where both the pixels and page 7
say **80A**. So numbers in photo-derived captions are now cross-checked against the PDFs
at ingest time, flagged if no document confirms them, and stripped out of the verifier's
evidence entirely.

### Step 3 — `tables.py`: five tables, checked against the source

Text extraction isn't enough for the specification table. On page 7 the columns
interleave when you read them in order:

```
Power Input / 120 VAC 60Hz / 240 VAC 60Hz / … / 40% @ 100 A / 100% @ 75 A
  / 25% @ 200 A / 100% @ 115 A
```

Which duty cycle belongs to which voltage is genuinely ambiguous in the text — and that's
precisely the question being graded. A model *looking at the rendered page* recovers the
columns.

But extraction can be wrong, so it's checked: **every number in an extracted table must
literally appear in that page's own text**, or the build reports it. Five tables — specs,
polarity, troubleshooting, process selection, setup procedures — all clean except two
flagged numbers in the setup steps, which are surfaced rather than hidden.

The polarity table got rebuilt once. The first attempt cited page 43, which only mentions
the rule in passing. The real sources are pages 13, 14 and 27 plus quick-start page 2 —
the only page covering all four processes. Citations matter here: the promise is that you
can walk to the machine and check.

---

## Why there's no vector database

This is the decision I most expect to be asked about.

The whole corpus is **51 pages — about 22,000 tokens**. The figure list is another
11,000. That fits inside a prompt-cached system prompt for roughly **16 cents per
conversation**. So I removed the search step completely:

- **The full manual text sits in the cached prompt**, every page tagged with its number.
  Cross-referencing page 43's porosity row against page 13's polarity diagram stops being
  a search problem. Top-k search is where cross-referenced questions go to die.
- **A list of every figure sits there too** — its ID, page, title, and the questions it
  answers. The model doesn't *search* for a figure; it reads a complete list and asks for
  one by name. **It can't miss one, because nothing was filtered out.**
- **Only the images themselves are fetched by tool**, because 134 pictures can't live in
  a prompt.

Two supporting reasons:

**Embeddings would need a second vendor.** Anthropic has no embedding API, so I'd need
Voyage or OpenAI — which breaks the "single API key in `.env`" requirement.

**I'd already measured that the fancy option loses.** In earlier work I benchmarked CLIP
image-text search against a plain caption-text baseline on document figures. CLIP lost
badly: 0.43 recall@5 against 0.80. Caption text beats joint embeddings on this kind of
content. This design takes that one step further — at this size you can skip ranking
altogether.

**One tuning detail:** storing full captions cost 25,000 tokens. Storing one line per
figure — just the title and the questions it answers — costs 11,000, with no loss. The
*questions* are what the model matches against; the description is payload, and it rides
along with the image when the figure is actually fetched.

**When I'd change this:** past roughly 150 pages, or with several products, the prompt
stops being cheap and keyword search goes back in over the same list. That's about thirty
lines, and the index is already shaped for it. Building a vector database for 51 pages
would be the wrong instinct to bring to a small team.

---

## The agent

Seven tools, served in-process through the Agent SDK. All the built-in Claude Code tools
are switched off by name — no shell, no filesystem, no web. The agent's whole world is
the committed index.

| Tool | What it does |
|---|---|
| `get_figure` | returns the actual image, plus its caption and page |
| `get_page` | returns a whole page image and its text |
| `get_table` | returns verified structured data |
| `compute_duty_cycle` | works it out in code; allowed to say "not specified" |
| `show_component` | renders one of six interactive panels |
| `render_diagram` | renders a diagram the model draws itself |
| `view_photo` | opens a photo the user attached |

### Fixed where it must be right, free where it doesn't matter

`show_component` and `render_diagram` are two halves of one job, split deliberately.

The six components — duty cycle calculator, polarity diagram, fault checklist, process
picker, machine setup, guided walkthrough — read the **verified tables**. The agent picks
which one to show and sets its starting values, but never supplies the content. So what
you click on can't drift away from the manual.

I'm not letting a language model free-draw which cable goes in which socket on a 240-volt
machine. `render_diagram` exists for the long tail where being roughly right is fine.

### Duty cycle is never estimated

The manual gives exactly **two** rated points per process per voltage — for MIG on 240V,
25% at 200A and 100% at 115A. No curve. Duty cycle isn't proportional to current, so
anything between those points is genuinely unknown.

So the tool returns the rated figure when your question lands on one, "100% continuous"
at or below the continuous rating, and an explicit **"the manual does not specify"** with
the two surrounding points otherwise. It never interpolates. Making up a duty cycle for a
welder is how somebody cooks the machine.

### The settings configurator refuses on purpose

Prox asked for "a settings configurator that takes process + material + thickness and
outputs recommended wire speed and voltage." I checked whether the manual supports that:
**"in/min" appears zero times in its text.** This welder is *synergic* — you give it wire
diameter and material thickness and it works out the speed and voltage itself. That's why
no table exists.

So the configurator gives everything the documents *do* determine — whether that process
suits the material and thickness, polarity and sockets, gas, allowed wire sizes, the
current range — and then says plainly that the machine derives the last two numbers, and
how to read its recommendation off the screen.

Inventing a wire-speed table would have satisfied the wording of the brief and been
wrong.

### Show it your weld

The brief asks for multimodal *responses* — agent to user. This runs the other way too.

Someone in a garage doesn't know the word "porosity". That's exactly why they couldn't
find it in the manual. So they photograph the bead instead. The agent opens the photo,
fetches the manual's own diagnosis chart from page 35, holds the two side by side, and
says which of the six reference beads yours matches — then gives that bead's printed fix
with its page number.

Three things this needed:

**Photos reach the model through a tool, not the prompt.** Sending images in the prompt
didn't work — the agent kept replying that no photo was attached — but images returned
from a *tool result* do arrive, which `get_figure` proves several times a session. So the
upload binds to a `view_photo` tool created for that request. That turned out better
anyway: looking at the photo becomes a visible step you can see in the transcript.

**"Your weld is fine" is a real answer.** A tool that finds a fault in every photo isn't
diagnosing, it's telling you what you want to hear. So the questions in the test set are
neutral — *"how does it look?"*, *"is this weld any good?"* — never *"what's wrong with
it?"*, which assumes a fault. An early version over-corrected and started calling
everything good, so the criteria now rule the six faults out one at a time, and *good* is
what's left over.

**It has to be able to say "that isn't a weld".** Shown the machine itself or its control
panel, it must decline rather than find a defect. Both those cases pass.

---

## It checks its own answers

Telling a model not to invent numbers isn't a control. So after every answer a
**deterministic check** runs — no model involved, about a millisecond — which pulls out
every quantity (amps, volts, percentages, wire speeds, gauges, minutes) and verifies it.

Two levels, because the two failures aren't equally serious:

- **Fabricated** — the number appears nowhere in any of the documents. This is the
  dangerous one.
- **Miscited** — the number is real, but not on the page the answer pointed at. Harmless
  to act on, still shown, because the whole promise is that you can check at the machine.

Evidence is also ranked. A page's text or a verified table is ground truth. A figure
caption is model-written prose about a picture — good enough to confirm a number exists
somewhere, never good enough to certify it. That distinction exists because the door
chart caption misread 80A as 65A, and treating captions as evidence would have let the
wrong number through wearing a green tick.

**It caught a real mistake in development.** The agent sourced a 1/2" contact-tip
distance to page 37 when the manual prints it on page 35. The answer looked perfect. I
would not have found that by reading it.

`npm run check` tests this offline, with no API calls at all.

---

## Testing

```bash
npm run dev            # in one terminal
npm run check          # the verifier, offline, free
npm run eval           # 8 text questions
npm run eval:welds     # 14 weld photos
```

### Text questions — 8/8, about $0.50 a run

| Case | What it tests |
|---|---|
| `duty-cycle` | the headline number, computed rather than guessed |
| `porosity` | diagnosis from the fault table, with the weld photo |
| `polarity-flux` | a picture, not a paragraph |
| `refusal-generator` | refusing cleanly on something never covered |
| `cross-reference` | 120V duty cycle *and* flux-cored polarity in one answer |
| `settings-configurator` | a setup answer that won't invent the missing numbers |
| `wiring-schematic` | surfacing an image-only page |
| `ambiguity` | asking for the missing fact instead of guessing |

Two are worth reading in full.

**The refusal.** Asked *"can I run this off a portable generator, what size?"* — the word
"generator" appears **zero times** in all three documents. It says so, declines to name a
wattage, then hands over the actual current-draw table from page 7 so you can size one
yourself, noting explicitly that's current draw and not a generator rating.

**The ambiguity.** Asked *"what's my duty cycle at 150 amps?"* it works out you must be on
240V (150A is beyond every 120V range), says it still needs the process, and explains
that 150A isn't one of the published points and duty cycle doesn't scale linearly — so it
won't interpolate one.

### Weld photos — 13/14, about $0.82 a run

Three groups, because ground truth matters more than volume:

- **Six reference beads** from page 35, cropped away from their captions so the diagnosis
  has to come from the picture rather than from reading the answer underneath. Ground
  truth is exact. Usually 6/7 including both phrasings of the good weld.
- **Five real photographs** from Wikimedia Commons, credited in
  `evals/welds/real/CREDITS.json`. There's no defect ground truth for these, so they're
  judged on what must hold regardless: it engaged with the image, reached a verdict,
  cited the manual, invented nothing. Worth reading the rail-weld answer — *"that's a
  piece of rusty railroad rail, and the vertical mark is a manufacturer's stamp."*
- **Two negatives** — the machine and its control panel — which must not be diagnosed.

**The one miss moves between runs.** `volts-low` and `travel-fast` are the two reference
beads closest to the boundary, and it drops one or the other. `volts-low` is a smooth,
even bead whose only fault is being *too narrow* — and cropping removed the neighbouring
panels that gave scale. In real use the plate is in frame. I stopped tuning there rather
than overfit the prompt to six line drawings; the real photographs score 5/5.

The real photos matter for a second reason: the model recognised my crops — *"this is a
diagram, not a photo, it looks like the manual's own porosity illustration."* Testing a
system on its own source material is circular.

---

## What it costs

Measured, not guessed.

- **Cached prompt:** about 37,000 tokens of index, plus 20–27,000 of fixed Agent SDK
  overhead. That overhead is unavoidable — `tools: []` does not remove it — and is worth
  knowing before you design around the SDK.
- **Per question:** $0.02–0.06 warm, about $0.19 on a cold cache.
- **Full test run:** ~$0.50 text, ~$0.82 photos.
- **Building the entire index, once:** about $3.

Defaults to `claude-sonnet-5`; set `MODEL=claude-opus-5` in `.env` for more headroom.

Sonnet is the default deliberately. The architecture removes the work that would need a
bigger model: recall comes from the prompt, arithmetic from a tool, figure choice from a
complete list, facts from verified tables. What's left is following instructions and
tone. Reaching for Opus would be paying a model to make up for an index I didn't build
properly.

---

## Other decisions worth defending

**No chat history, no persistence.** The conversation lives in memory; refreshing clears
it. Nothing is written to disk or to your browser. Their brief never asks for it, and
"we stored your conversation" is a liability on a page where people paste API keys. The
only caching involved is Anthropic's prompt cache, which is a billing mechanism on the
request, not storage.

**Every request is stateless.** Each turn replays the transcript rather than resuming an
SDK session, because sessions live in a per-instance temp directory that the next request
may not land on. Replaying is free, because the prompt is identical and cached.

**Deployability was verified before anything else was built.** The Agent SDK resolves a
~219 MB native binary per platform and runs it as a subprocess. Next.js doesn't see it,
so `next.config.ts` includes it explicitly. I deployed a probe endpoint first to confirm
it boots on Vercel before committing to the platform.

**Two languages, one runtime.** Ingest is Python because nothing else handles
vector-figure geometry as well. The shipped app is TypeScript only — a reviewer never
runs Python. The index is a build artifact, like a compiled asset.

**A small markdown renderer instead of a library.** About 40 lines covering paragraphs,
lists, headings, bold, code and tables. Writing it by hand is what lets every `[p.14]`
become a button that opens that page.

---

## Does it work on other manuals?

Not as an upload, and that's deliberate — nothing is extracted at request time, which is
why setup takes two minutes.

But the pipeline isn't welder-specific. `extract.py` finds figures by clustering vector
ink with no product-specific rules; `caption.py` and `tables.py` are prompted with the
document, not the product. Pointing them at another manual is three commands:

```bash
python ingest/extract.py && python ingest/caption.py --go && python ingest/tables.py --go
```

What's hand-tuned is small and visible: the five table definitions, and the crop regions
for the door photograph.

Doing this for many products means running that pipeline as a background job on upload
and keying the index by product — minutes and a couple of dollars of vision calls per
manual, not something to do inside a web request. The architecture already assumes that
split; it just runs the job on my machine instead of a queue.

---

## The interface

Two visual registers that never mix. Answers are **paper** — you read them. Machine data
is **panel** — near-black with white readouts, the way the welder's own LCD shows it.
Colour is never decoration: **ember means electrically live**, amber means unverified,
green means checked.

- **Artifact frames.** Every figure, instrument and generated diagram sits in a titled
  panel with its source page, an enlarge control, and — for diagrams the model drew — a
  toggle to see the actual code it produced.
- **The landing page runs a live instrument** before you enter any key, because the
  components run on committed data.
- **An index browser** shows all 122 kept figures with their captions. Extraction quality
  is a claim; this makes it something you can check.
- **Voice both ways.** The composer lights up with a live meter while listening.
  Hands-free reads answers back — best installed voice, spoken sentence by sentence so
  the pauses land, rewritten for the ear ("[p.35]" becomes "page 35"). In the guided
  setup it reads **the step you're standing on** and re-reads when you advance, which is
  the whole point: gloves on, both hands on the machine.
- **Photos** by drag, paste or browse.
- **Live tool status** — which tool is running, on what, right now.
- **Print styles**, because answers get carried to the machine.
- Keyboard: `Enter` sends, `⌘K` focuses, `Esc` closes. Citations are buttons.

---

## Repo map

```
files/           the three PDFs, as provided
product*.webp    the product photos, as provided
ingest/          offline, run once by me. You never run these.
  extract.py       text, figure regions, page renders
  caption.py       one vision caption per figure, cached
  tables.py        five structured tables + number checking
public/kb/       the committed index (JSON + WebP), served by CDN
lib/
  kb.ts            loads the index, builds the cached prompt
  tools.ts         the seven agent tools
  duty.ts          duty cycle logic, shared with the browser
  verify.ts        the post-answer check
app/
  api/chat/route.ts   the agent, streaming
  api/health/route.ts whether this deployment has its own key
  components/         the chat UI and the six interactive panels
evals/
  run.mjs          8 text cases
  welds.mjs        14 photo cases
  verify.test.mjs  the verifier, offline
  welds/           test images + Wikimedia credits
```

---

## Known limits

- Conversation history is text-only; figures from earlier turns aren't re-sent as images.
- The verifier checks numbers, not claims. "Use argon" would pass unexamined.
- Figure crops on two dense pages still include the section-tab margin.
- One weld case out of fourteen fails per run, and which one varies.
- Voice quality depends on the voices installed on your machine — noticeably better on
  macOS than Windows.
- Two numbers in the setup table are flagged unverified. They're surfaced, not hidden.

---

Built by **Shivani Bokka**. Answers come from the Vulcan OmniPro 220 manuals — verify at
the machine.
