/**
 * Weld photo eval — "is this weld any good?", not just "find the defect".
 *
 * Three groups, because a diagnostic tool that only ever finds faults is not
 * diagnosing, it is flattering the question:
 *
 *   reference  the manual's own six beads from page 35, cropped away from their
 *              captions. Ground truth is exact. Includes the good weld, which must
 *              come back as good.
 *   real       five photographs of actual welds from Wikimedia Commons (credits in
 *              welds/real/CREDITS.json). No defect ground truth exists for these, so
 *              they are judged on the things that must hold regardless: it engaged
 *              with the image, it reached a verdict, it cited the manual, and it
 *              invented nothing.
 *   negative   the welder and its control panel. Must decline to diagnose a weld.
 *
 * Questions are phrased neutrally on purpose. "What's wrong with it?" presupposes a
 * fault and biases the answer; "how does it look?" does not.
 *
 *   npm run dev
 *   npm run eval:welds
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.EVAL_BASE ?? 'http://localhost:3111'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WELDS = path.join(HERE, 'welds')
const REAL = path.join(WELDS, 'real')
const ROOT = path.join(HERE, '..')

const manifest = JSON.parse(readFileSync(path.join(WELDS, 'manifest.json'), 'utf8'))
const credits = existsSync(path.join(REAL, 'CREDITS.json'))
  ? JSON.parse(readFileSync(path.join(REAL, 'CREDITS.json'), 'utf8'))
  : []

/**
 * What counts as landing on the right reference bead. Matching the manual's exact
 * caption would test phrasing, not diagnosis — "you're moving too quickly, slow down"
 * is a correct answer to Travel Speed Too Fast. Each pattern accepts the manual's own
 * label or the correction it prescribes.
 */
const MATCH = {
  good: /good weld|looks (good|solid|fine|healthy|right|correct)|nothing (is )?wrong|no (obvious |visible )?(defect|fault|problem)|well.formed|textbook|matches the good/i,
  'volts-low': /voltage .{0,14}too low|wire.?feed .{0,14}too slow|increase (the )?(output )?voltage|increase (the )?wire.?feed|too cold/i,
  'volts-high': /voltage .{0,14}too high|wire.?feed .{0,14}too fast|decrease (the )?(output )?voltage|reduce (the )?(output )?voltage|decrease (the )?wire.?feed|too hot/i,
  'travel-fast': /travel(ling|ing)?( speed)?[^.]{0,18}too fast|moving too (fast|quickly)|travel slower|slow (your |the )?travel|slow down/i,
  'travel-slow': /travel(ling|ing)?( speed)?[^.]{0,18}too slow|moving too slow|travel faster|speed up|dwell(ing|ed)? too long/i,
  'ctwd-polarity': /ctwd|contact.tip.to.work|wrong polarity|stick.?out|polarity (is )?(wrong|reversed|backwards)/i,
}

/** A verdict of any kind — the answer must land somewhere, not just describe. */
const VERDICT = /good weld|looks (good|solid|fine|acceptable|healthy)|nothing wrong|no (obvious |visible )?(defect|fault)|too (hot|cold|fast|slow|high|low)|porosity|spatter|undercut|voltage|travel speed|ctwd|wire.?feed|can'?t (tell|diagnose)|cannot (tell|diagnose)|hard to (tell|say)|need a (clearer|better|straight)|not (a )?(completed |finished )?weld|isn'?t a (completed |finished )?weld|not diagnosable|don'?t want to guess|not from this welder/i
/** Evidence it actually looked at the picture rather than answering generically. */
const ENGAGED = /bead|ripple|toe|profile|spatter|crown|weld pool|penetration|seam|surface|convex|flat|width/i
const DECLINE = /not a weld|isn'?t a weld|is not a (weld|bead)|no weld|control panel|the welder itself|the machine itself|front panel|can'?t diagnose|cannot diagnose|not a (photo|picture) of a weld|this is the (machine|welder)/i
const DEFECT = /voltage too|travel speed too|ctwd too|wire feed too|porosity in your/i

const CASES = [
  // 1. Reference beads, exact ground truth. Neutral phrasing.
  ...manifest.map((m) => ({
    group: 'reference',
    id: m.file.replace('.webp', ''),
    file: path.join(WELDS, m.file),
    ask: 'Here is my weld. How does it look?',
    truth: m.truth,
    match: MATCH[m.file.replace('.webp', '')],
    anyCite: [35, 43],
  })),
  // The same good bead asked the other way round: a user wanting reassurance.
  {
    group: 'reference',
    id: 'good-asked-directly',
    file: path.join(WELDS, 'good.webp'),
    ask: 'Is this weld any good, or do I need to redo it?',
    truth: 'Good Weld, asked as a yes/no',
    match: MATCH.good,
    anyCite: [35],
  },
  // 2. Real photographs. No defect ground truth; judged on rigour, not on label.
  ...credits.map((c) => ({
    group: 'real',
    id: c.file.replace('.webp', ''),
    file: path.join(REAL, c.file),
    ask: 'Is this weld any good?',
    truth: `${c.what} (${c.licence})`,
    engaged: true,
    verdict: true,
    anyCite: [35, 37, 43],
  })),
  // 3. Negatives. Must not find a weld defect in something that is not a weld.
  {
    group: 'negative',
    id: 'negative-machine',
    file: path.join(ROOT, 'product.webp'),
    ask: 'Here is my weld. How does it look?',
    truth: 'the welder itself, not a weld',
    refuse: true,
  },
  {
    group: 'negative',
    id: 'negative-panel',
    file: path.join(ROOT, 'public', 'kb', 'figures', 'manual-p20-f3.webp'),
    ask: 'Is this weld any good?',
    truth: 'the control panel, not a weld',
    refuse: true,
  },
]

async function run(c) {
  const data = readFileSync(c.file).toString('base64')
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: c.ask }],
      images: [{ mediaType: 'image/webp', data }],
    }),
  })
  if (!res.ok) return { ...c, fail: [`HTTP ${res.status}`], text: '', cost: 0, tools: [] }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  const tools = []
  let verdict = null
  let cost = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.startsWith('data: ')) continue
      const e = JSON.parse(p.slice(6))
      if (e.type === 'text') text += e.delta
      else if (e.type === 'tool') tools.push(e.name)
      else if (e.type === 'done') { verdict = e.verdict; cost = e.costUsd ?? 0 }
    }
  }

  const fail = []
  if (!tools.includes('view_photo')) fail.push('never opened the photo')

  if (c.refuse) {
    if (!DECLINE.test(text)) fail.push('did not say it is not a weld')
    if (DEFECT.test(text) && !DECLINE.test(text)) fail.push('diagnosed a weld defect anyway')
  } else {
    if (c.match && !c.match.test(text)) fail.push(`missed "${c.truth}"`)
    if (c.engaged && !ENGAGED.test(text)) fail.push('did not describe the image')
    if (c.verdict && !VERDICT.test(text)) fail.push('reached no verdict')
    if (c.anyCite && !c.anyCite.some((n) => verdict?.citedPages.includes(`p.${n}`))) {
      fail.push(`cited none of ${c.anyCite.map((n) => 'p.' + n).join(', ')}`)
    }
  }
  if (verdict?.fabricated.length) fail.push(`FABRICATED: ${verdict.fabricated.join(', ')}`)

  return { group: c.group, id: c.id, truth: c.truth, ask: c.ask, text, tools, verdict, cost, fail }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const pick = (c) => !only.length || only.includes(c.id) || only.includes(c.group)
const results = []
let total = 0
let group = ''
for (const c of CASES.filter(pick)) {
  if (c.group !== group) { group = c.group; console.log(`\n— ${group} —`) }
  process.stdout.write(`${c.id.padEnd(20)} `)
  const r = await run(c)
  results.push(r)
  total += r.cost
  console.log(`${r.fail.length ? 'FAIL' : 'pass'}  $${r.cost.toFixed(4)}  [${r.tools.join(' ') || 'none'}]`)
  for (const f of r.fail) console.log(`     x ${f}`)
  if (r.fail.length) console.log(`       said: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}…`)
}

writeFileSync(path.join(HERE, 'welds-results.json'), JSON.stringify(results, null, 1))
const passed = results.filter((r) => !r.fail.length).length
console.log(`\n${passed}/${results.length} passed   $${total.toFixed(4)} total`)
process.exit(passed === results.length ? 0 : 1)
