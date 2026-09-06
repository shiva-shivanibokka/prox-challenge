/**
 * Eval harness. Runs the questions this system was built to get right against a
 * running server, and reports what actually happened: which tools fired, what got
 * rendered, whether every quantity in the answer traced back to a cited page, and
 * what it cost.
 *
 *   npm run dev            # in one terminal
 *   npm run eval           # in another
 *   npm run eval -- --model claude-opus-5
 *
 * Writes evals/results.json. Each case declares what a correct answer must contain,
 * so this is a check, not a demo reel.
 */
import { writeFileSync } from 'node:fs'

const BASE = process.env.EVAL_BASE ?? 'http://localhost:3111'

const CASES = [
  {
    id: 'duty-cycle',
    tests: 'the headline number, computed not guessed',
    ask: "What's the duty cycle for MIG welding at 200A on 240V?",
    expect: {
      text: [/25\s*%/, /2\.5|2-1\/2/, /7\.5|7-1\/2/],
      tools: ['compute_duty_cycle'],
      visual: true,
      cites: [7],
    },
  },
  {
    id: 'porosity',
    tests: 'diagnosis from the troubleshooting matrix, with the weld photo',
    ask: 'My flux-cored welds have porosity. What should I check?',
    expect: {
      text: [/gas|contamina|clean|polarit/i, /DCEN/],
      anyTool: ['get_table', 'get_figure', 'show_component'],
      visual: true,
      // p.43 is the troubleshooting row, p.37 the porosity figure. Either is a
      // legitimate source for this answer.
      anyCite: [37, 43],
    },
  },
  {
    id: 'polarity-flux',
    tests: 'a picture, not a paragraph',
    ask: 'How do I set polarity for flux-cored? Which socket does the ground clamp go in?',
    expect: {
      text: [/DCEN/, /positive/i],
      visual: true,
      anyTool: ['get_table', 'get_figure', 'show_component'],
      cites: [13],
    },
  },
  {
    id: 'refusal-generator',
    tests: 'refusing cleanly on something the manuals never cover',
    ask: 'Can I run this welder off a portable generator? What size generator do I need?',
    expect: {
      text: [/does not|doesn't|no .*(guidance|information|spec)|not covered|nothing about/i],
      refuses: true,
      mustNotContain: [/\b\d{3,5}\s*(W|watt|kVA)/i],
    },
  },
  {
    id: 'cross-reference',
    tests: 'two sections combined: the 120V duty cycle and the flux-cored polarity',
    ask: "I'm running flux-cored on 120V at 100A. How long can I weld before resting, and which socket does my ground clamp go in?",
    expect: {
      text: [/40\s*%/, /4\s*min/i, /6\s*min/i, /positive/i],
      tools: ['compute_duty_cycle', 'get_table'],
      visual: true,
      cites: [7],
    },
  },
]

async function run(c) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: c.ask }] }),
  })
  if (!res.ok) return { ...c, fail: [`HTTP ${res.status}`], text: '', cost: 0 }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  const tools = []
  const visuals = []
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
      else if (e.type === 'figure') visuals.push(`figure:${e.id}`)
      else if (e.type === 'component') visuals.push(`component:${e.component}`)
      else if (e.type === 'diagram') visuals.push('diagram')
      else if (e.type === 'done') { verdict = e.verdict; cost = e.costUsd ?? 0 }
    }
  }

  const x = c.expect
  const fail = []
  for (const re of x.text ?? []) if (!re.test(text)) fail.push(`missing ${re}`)
  for (const re of x.mustNotContain ?? []) if (re.test(text)) fail.push(`must not contain ${re}`)
  for (const t of x.tools ?? []) if (!tools.includes(t)) fail.push(`never called ${t}`)
  if (x.anyTool && !x.anyTool.some((t) => tools.includes(t))) fail.push(`called none of ${x.anyTool}`)
  if (x.visual && visuals.length === 0) fail.push('answered with no visual')
  for (const p of x.cites ?? []) {
    if (!verdict?.citedPages.includes(`p.${p}`)) fail.push(`did not cite p.${p}`)
  }
  if (x.anyCite && !x.anyCite.some((p) => verdict?.citedPages.includes(`p.${p}`))) {
    fail.push(`cited none of ${x.anyCite.map((p) => 'p.' + p).join(', ')}`)
  }
  // A fabricated number is a failure. A miscitation is a real defect too, but the
  // value exists in the manuals -- report it without failing the run.
  if (verdict?.fabricated.length) fail.push(`FABRICATED: ${verdict.fabricated.join(', ')}`)

  const warn = verdict?.miscited.length ? [`miscited: ${verdict.miscited.join(', ')}`] : []
  return { id: c.id, tests: c.tests, ask: c.ask, text, tools, visuals, verdict, cost, fail, warn }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const results = []
let total = 0
for (const c of CASES.filter((c) => !only.length || only.includes(c.id))) {
  process.stdout.write(`${c.id} ... `)
  const r = await run(c)
  results.push(r)
  total += r.cost
  console.log(
    `${r.fail.length ? 'FAIL' : 'pass'}  $${r.cost.toFixed(4)}  ` +
      `[${r.tools.join(' ') || 'no tools'}]${r.visuals.length ? ` (${r.visuals.length} visual)` : ''}`,
  )
  for (const f of r.fail) console.log(`     x ${f}`)
  for (const w of r.warn ?? []) console.log(`     ~ ${w}`)
}

const passed = results.filter((r) => !r.fail.length).length
console.log(`\n${passed}/${results.length} passed   $${total.toFixed(4)} total`)
writeFileSync(
  new URL('results.json', import.meta.url),
  JSON.stringify({ model: process.env.MODEL ?? 'claude-sonnet-5', total, results }, null, 1),
)
process.exit(passed === results.length ? 0 : 1)
