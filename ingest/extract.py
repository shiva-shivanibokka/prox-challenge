"""
Offline extraction. Run once; commit the output. The runtime never opens a PDF.

Why this is not a normal PDF pipeline: in this manual the figures are *vector art*,
not embedded raster images. page.get_images() returns 0 on most figure pages, while
page.get_drawings() returns thousands of primitives (p47, the wiring schematic, has
26,144). So figures are found by rasterising a coarse occupancy mask of the vector
primitives, taking connected components, and rendering those page regions -- not by
pulling embedded image XObjects, which would silently return almost nothing.

    python ingest/extract.py
"""
from __future__ import annotations

import json
import shutil
from collections import Counter
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
FILES = ROOT / "files"
OUT = ROOT / "knowledge"

DOCS = [
    ("owner-manual.pdf", "manual"),
    ("quick-start-guide.pdf", "quickstart"),
    ("selection-chart.pdf", "chart"),
]

CELL = 4.0          # occupancy-mask cell size, in PDF points
PAD = 7.0           # dilate every primitive by this before masking, to merge parts
MIN_SIDE = 14.0     # drop slivers: rules, underlines, table borders
MIN_AREA = 4000.0   # drop specks, in square points (~1.4% of an A4 page)
FIG_DPI = 200       # crops: read by a vision model, and zoomable in the UI
PAGE_DPI = 110      # full pages: shown as "here is the page", not read closely
FURNITURE_HITS = 0.35  # a region repeating on >=35% of pages is page chrome
MARGIN_HITS = 0.7      # an x-band inked on >=70% of pages is a margin tab strip
MAX_ASPECT = 6.0       # a 14:1 component is a rule or a tab strip, not a figure
MAX_GROWTH = 1.6       # a crop may not balloon past this while absorbing labels


def mask_components(page: fitz.Page) -> list[fitz.Rect]:
    """Connected components of the page's vector+raster ink, as page-space rects."""
    pr = page.rect
    cols, rows = int(pr.width / CELL) + 1, int(pr.height / CELL) + 1
    grid = bytearray(cols * rows)

    rects = [d["rect"] for d in page.get_drawings()]
    for img in page.get_images(full=True):
        rects.extend(page.get_image_rects(img[0]))

    for r in rects:
        r = fitz.Rect(r) & pr
        if r.is_empty:
            continue
        # A single hairline is not a figure, but it may be part of one, so it still
        # gets masked -- MIN_SIDE filtering happens on the merged component instead.
        x0 = max(0, int((r.x0 - PAD) / CELL))
        x1 = min(cols - 1, int((r.x1 + PAD) / CELL))
        y0 = max(0, int((r.y0 - PAD) / CELL))
        y1 = min(rows - 1, int((r.y1 + PAD) / CELL))
        for y in range(y0, y1 + 1):
            base = y * cols
            for x in range(x0, x1 + 1):
                grid[base + x] = 1

    out: list[fitz.Rect] = []
    seen = bytearray(cols * rows)
    for start in range(cols * rows):
        if not grid[start] or seen[start]:
            continue
        stack, cells = [start], []
        seen[start] = 1
        while stack:
            i = stack.pop()
            cells.append(i)
            y, x = divmod(i, cols)
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < rows and 0 <= nx < cols:
                    j = ny * cols + nx
                    if grid[j] and not seen[j]:
                        seen[j] = 1
                        stack.append(j)
        xs = [c % cols for c in cells]
        ys = [c // cols for c in cells]
        out.append(fitz.Rect(min(xs) * CELL, min(ys) * CELL,
                             (max(xs) + 1) * CELL, (max(ys) + 1) * CELL) & pr)
    return out


def trim(im: Image.Image, bg: int = 250) -> Image.Image:
    """Drop the uniform white border around a render.

    selection-chart.pdf is a 1200x1200 page whose artwork occupies a central band;
    without this the crop is mostly white and the vision model reads it at a
    fraction of the resolution it could.
    """
    grey = im.convert("L").point(lambda v: 0 if v >= bg else 255)
    box = grey.getbbox()
    if not box:
        return im
    pad = 6
    return im.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                    min(im.width, box[2] + pad), min(im.height, box[3] + pad)))


def content_box(doc: fitz.Document, per_page: list[list[fitz.Rect]]) -> fitz.Rect:
    """Page rect minus the margin bands the section tabs live in.

    The tabs shift and re-highlight per page, so their bounding boxes never repeat
    exactly and the frequency filter misses them. Their *x-band* is rock steady, so
    detect that instead: columns inked on nearly every page are chrome, not content.
    """
    pr = doc[0].rect
    # Needs a population to compare against. On a 1-2 page document every inked
    # column trivially appears on "most" pages, which would collapse the box to
    # nothing and silently drop the whole document -- including selection-chart.pdf.
    if len(per_page) < 5:
        return pr
    cols = int(pr.width / CELL) + 1
    hits = [0] * cols
    for comps in per_page:
        inked = set()
        for r in comps:
            inked.update(range(max(0, int(r.x0 / CELL)), min(cols, int(r.x1 / CELL) + 1)))
        for c in inked:
            hits[c] += 1
    thresh = MARGIN_HITS * len(per_page)
    left, right = 0, cols - 1
    while left < cols and hits[left] >= thresh:
        left += 1
    while right > left and hits[right] >= thresh:
        right -= 1
    return fitz.Rect(left * CELL, pr.y0, (right + 1) * CELL, pr.y1)


def absorb_labels(page: fitz.Page, r: fitz.Rect) -> tuple[fitz.Rect, str]:
    """Grow a region to cover the callout text sitting inside or hard against it.

    Figure labels ("Power Switch", "Left Knob") are page text, not vector ink, so the
    mask misses them. A crop without its labels is useless to both the model and the user.
    """
    grown = fitz.Rect(r)
    near = fitz.Rect(r.x0 - 6, r.y0 - 6, r.x1 + 6, r.y1 + 6)
    words = []
    for x0, y0, x1, y1, w, *_ in page.get_text("words"):
        wr = fitz.Rect(x0, y0, x1, y1)
        # Only absorb words mostly enclosed by the region; a neighbouring paragraph
        # merely touching the edge must not drag the crop across the page.
        inter = wr & near
        if not inter.is_empty and inter.get_area() > 0.6 * wr.get_area():
            cand = grown | wr
            # A caption sits beside the figure; a body paragraph would swallow it.
            if cand.get_area() <= MAX_GROWTH * r.get_area():
                grown = cand
                words.append(w)
    return grown & page.rect, " ".join(words)


def quantise(r: fitz.Rect, q: int = 12) -> tuple[int, ...]:
    return tuple(int(v / q) for v in (r.x0, r.y0, r.x1, r.y1))


def main() -> None:
    for sub in ("pages", "figures"):
        d = OUT / sub
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    pages_out, figures_out = [], []

    for fname, doc_id in DOCS:
        doc = fitz.open(FILES / fname)

        # Pass 1: find page chrome -- the section tabs and rules that repeat everywhere.
        freq: Counter[tuple[int, ...]] = Counter()
        per_page: list[list[fitz.Rect]] = []
        for page in doc:
            comps = mask_components(page)
            per_page.append(comps)
            for r in comps:
                freq[quantise(r)] += 1
        chrome = {k for k, n in freq.items() if n >= max(3, FURNITURE_HITS * len(doc))}
        content = content_box(doc, per_page)

        # Pass 1b: the same trick on text -- header/footer boilerplate on all 48 pages
        # is ~10 lines of pure noise per page in the model's context.
        line_freq: Counter[str] = Counter()
        for page in doc:
            for ln in {l.strip() for l in page.get_text().splitlines() if l.strip()}:
                line_freq[ln] += 1
        boiler = {l for l, n in line_freq.items() if n >= max(3, 0.5 * len(doc))}

        for idx, page in enumerate(doc):
            num = idx + 1
            text = "\n".join(l for l in page.get_text().splitlines()
                             if l.strip() and l.strip() not in boiler)

            page.get_pixmap(dpi=PAGE_DPI).pil_save(
                OUT / "pages" / f"{doc_id}-p{num:02d}.webp", quality=82, method=4)

            kept = 0
            for r in sorted(per_page[idx], key=lambda r: (r.y0, r.x0)):
                if quantise(r) in chrome:
                    continue
                r = r & content  # never crop the section-tab margins into a figure
                if r.is_empty or r.width < MIN_SIDE or r.height < MIN_SIDE:
                    continue
                if r.get_area() < MIN_AREA:
                    continue
                if max(r.width / r.height, r.height / r.width) > MAX_ASPECT:
                    continue  # rules, borders, tab strips
                grown, labels = absorb_labels(page, r)
                grown &= content
                kept += 1
                fig_id = f"{doc_id}-p{num:02d}-f{kept}"
                pm = page.get_pixmap(dpi=FIG_DPI, clip=grown)
                trim(Image.frombytes("RGB", (pm.width, pm.height), pm.samples)).save(
                    OUT / "figures" / f"{fig_id}.webp", quality=88, method=4)
                figures_out.append({
                    "id": fig_id, "doc": doc_id, "page": num,
                    "bbox": [round(v, 1) for v in grown],
                    "area_frac": round(grown.get_area() / page.rect.get_area(), 3),
                    "labels": labels[:600],
                })

            pages_out.append({"doc": doc_id, "page": num, "text": text})

        doc.close()

    (OUT / "pages.json").write_text(json.dumps(pages_out, indent=1), encoding="utf-8")
    (OUT / "figures.json").write_text(json.dumps(figures_out, indent=1), encoding="utf-8")

    chars = sum(len(p["text"]) for p in pages_out)
    size = sum(f.stat().st_size for f in OUT.rglob("*.webp"))
    print(f"pages   {len(pages_out)}  ({chars:,} chars, ~{chars // 4:,} tokens)")
    print(f"figures {len(figures_out)}")
    print(f"images  {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
