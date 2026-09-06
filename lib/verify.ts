/**
 * Post-answer grounding check. Deterministic, no model call, runs in about a
 * millisecond.
 *
 * The system prompt tells the agent not to invent numbers. This checks, at two
 * levels, because the two failures are not equally serious:
 *
 *   fabricated -- the quantity appears nowhere in any of the three documents, nor in
 *                 any tool result from this turn. This is the dangerous one: a
 *                 confident amperage or duty cycle that does not exist.
 *   miscited   -- the quantity is real, but not on the page the answer pointed at.
 *                 Harmless to act on, still worth showing, because the promise of
 *                 this product is that you can walk to the machine and check.
 *
 * This is the cheap, dependency-free descendant of an NLI faithfulness gate. It
 * cannot judge entailment, but it does catch the failure that actually matters on a
 * welder -- and it caught a real one during development: the agent sourced a 1/2"
 * contact-tip-to-work distance to page 37 when the manual prints it on page 35.
 */
import { captions, catalogue, pages, pageText } from './kb'

const DOCS: Record<string, string> = {
  'quick start guide': 'quickstart',
  'quick start': 'quickstart',
  'selection chart': 'chart',
  chart: 'chart',
}

/** A number carrying a unit. Bare integers are skipped: too noisy to be evidence. */
const QUANTITY =
  /\b(\d+(?:[.,]\d+)?(?:[-–/]\d+(?:\/\d+)?)?)\s*(%|A\b|amps?\b|V\b|VAC\b|VDC\b|volts?\b|IPM\b|SCFH\b|Hz\b|ga\b|gauge\b|lb\b|in\b|inch(?:es)?\b|"|minutes?\b|min\b)/gi

/** [p.7] · [p.7, p.19] · [Quick Start Guide p.2] */
const CITATION = /\[([^\]]*?p\.?\s*\d+[^\]]*?)\]/gi

export type Verdict = {
  citedPages: string[]
  checked: number
  miscited: string[]
  fabricated: string[]
}

const normalise = (s: string) => s.toLowerCase().replace(/[–—]/g, '-').replace(/,/g, '')

/** Everything the three documents say, including figure transcriptions. Built once. */
const CORPUS = normalise(
  [
    ...pages.map((p) => p.text),
    ...catalogue.flatMap((f) => [
      f.caption.summary,
      ...(captions[f.id]?.visible_text ?? []),
    ]),
  ].join('\n'),
)

export function citedPages(answer: string): { doc: string; page: number }[] {
  const out: { doc: string; page: number }[] = []
  for (const m of answer.matchAll(CITATION)) {
    const body = m[1]
    let doc = 'manual'
    for (const [name, id] of Object.entries(DOCS)) {
      if (body.toLowerCase().includes(name)) doc = id
    }
    for (const p of body.matchAll(/p\.?\s*(\d+)/gi)) out.push({ doc, page: Number(p[1]) })
  }
  return out.filter(
    (v, i) => out.findIndex((o) => o.doc === v.doc && o.page === v.page) === i,
  )
}

/** "2-1/2" in the manual is "2.5" out of the calculator; ".030" is written "0.030". */
function spellings(n: string): string[] {
  const forms = new Set([n, n.replace(/^0\./, '.'), n.replace(/^\./, '0.')])
  const num = Number(n)
  if (Number.isFinite(num)) {
    forms.add(String(num))
    const whole = Math.floor(num)
    const frac = num - whole
    for (const [f, txt] of [[0.5, '1/2'], [0.25, '1/4'], [0.75, '3/4']] as const) {
      if (Math.abs(frac - f) < 1e-9) forms.add(`${whole}-${txt}`)
    }
  }
  return [...forms]
}

/**
 * @param answer     the assistant's final text
 * @param toolOutput everything the deterministic tools returned this turn
 */
export function verify(answer: string, toolOutput: string[]): Verdict {
  const cited = citedPages(answer)

  // Narrow evidence: only the pages this answer actually pointed at, plus figure
  // transcriptions from those pages, plus this turn's tool results -- a tool result
  // counts because it was read straight out of the verified index.
  const near = normalise(
    [
      ...cited.map((c) => pageText(c.doc, c.page)),
      ...catalogue
        .filter((f) => cited.some((c) => c.doc === f.doc && c.page === f.page))
        .flatMap((f) => [f.caption.summary, ...(captions[f.id]?.visible_text ?? [])]),
      ...toolOutput,
    ].join('\n'),
  )
  const wide = CORPUS + '\n' + normalise(toolOutput.join('\n'))

  const miscited: string[] = []
  const fabricated: string[] = []
  const seen = new Set<string>()
  let checked = 0

  for (const m of answer.matchAll(QUANTITY)) {
    const whole = m[0].trim()
    if (seen.has(whole.toLowerCase())) continue
    seen.add(whole.toLowerCase())
    checked++
    const forms = spellings(normalise(m[1]))
    if (forms.some((f) => near.includes(f))) continue
    if (forms.some((f) => wide.includes(f))) miscited.push(whole)
    else fabricated.push(whole)
  }

  return {
    citedPages: cited.map((c) => (c.doc === 'manual' ? `p.${c.page}` : `${c.doc} p.${c.page}`)),
    checked,
    miscited,
    fabricated,
  }
}
