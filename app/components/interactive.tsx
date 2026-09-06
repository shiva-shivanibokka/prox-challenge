'use client'

/**
 * The four interactive components the agent can put on screen.
 *
 * Every one reads the verified tables rather than anything the model produced, so
 * what a user sees and pokes at cannot drift from the manual. The agent chooses
 * which component to show and seeds its starting values; it never supplies content.
 * That is the whole reason these exist alongside render_diagram: correctness where
 * it matters, freehand only where it doesn't.
 */
import { useState } from 'react'
import tablesJson from '../../public/kb/tables.json'
import { SPECS, dutyCycle } from '../../lib/duty'

type Props = Record<string, unknown>
const T = tablesJson as Record<string, { sources: string[]; data: any }>

const str = (p: Props, k: string, d = '') => (typeof p[k] === 'string' ? (p[k] as string) : d)
const num = (p: Props, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d)

function Panel({ title, source, children }: { title: string; source: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-hd">
        <b>{title}</b>
        <span style={{ marginLeft: 'auto' }}>{source}</span>
      </div>
      <div className="panel-bd">{children}</div>
    </section>
  )
}

/* ------------------------------------------------------- duty cycle calculator */

function DutyCycleCalculator(p: Props) {
  const [proc, setProc] = useState(str(p, 'process', 'MIG'))
  const [volts, setVolts] = useState(num(p, 'input_volts', 240))
  const spec = SPECS.find((s) => s.process === proc && s.input_volts === volts)
  const [lo, hi] = spec?.current_range_a ?? [30, 220]
  const [amps, setAmps] = useState(Math.min(Math.max(num(p, 'amps', 200), lo), hi))

  const clamp = (a: number) => Math.min(Math.max(a, lo), hi)
  const d = dutyCycle(proc, volts, clamp(amps))
  const rated = d.ok && d.rated

  return (
    <Panel title="Duty cycle" source="Specifications, p.7">
      <div className="ctl">
        <div>
          <label htmlFor="dc-p">Process</label>
          <select id="dc-p" value={proc} onChange={(e) => setProc(e.target.value)}>
            {[...new Set(SPECS.map((s) => s.process))].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dc-v">Input voltage</label>
          <select id="dc-v" value={volts} onChange={(e) => setVolts(Number(e.target.value))}>
            <option value={120}>120V</option>
            <option value={240}>240V</option>
          </select>
        </div>
        <div>
          <label htmlFor="dc-a">
            Welding current — {clamp(amps)}A <span style={{ opacity: 0.6 }}>({lo}–{hi}A)</span>
          </label>
          <input
            id="dc-a" type="range" min={lo} max={hi} step={5}
            value={clamp(amps)} onChange={(e) => setAmps(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="readout">
        <div className={`cell${rated && d.percent !== 100 ? ' hot' : ''}`}>
          <div className="k">Rated duty cycle</div>
          <div className="v">{rated ? d.percent : '—'}<span className="u">{rated ? '%' : ''}</span></div>
        </div>
        <div className="cell">
          <div className="k">Welding</div>
          <div className="v">{rated ? d.weldMinutes : '—'}<span className="u">min</span></div>
        </div>
        <div className="cell">
          <div className="k">Then resting</div>
          <div className="v">{rated ? d.restMinutes : '—'}<span className="u">min</span></div>
        </div>
      </div>

      {!rated && <p className="note">{d.message}</p>}
      {rated && d.percent !== 100 && (
        <p className="note">
          Per 10 minutes. Run past this and the thermal cut-out trips — a warning screen
          appears and the machine shuts down until it cools, with the fan running if you
          leave the power switch on [p.23].
        </p>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------ polarity diagram */

function PolarityDiagram(p: Props) {
  const setups: any[] = T.polarity?.data?.setups ?? []
  const [proc, setProc] = useState(
    setups.find((s) => s.process.toLowerCase() === str(p, 'process').toLowerCase())?.process ??
      setups[0]?.process ?? '',
  )
  const s = setups.find((x) => x.process === proc)
  if (!s) return null

  const sockets = [
    { sign: '−', lead: s.ground_clamp_socket === '-' ? 'Ground clamp' : s.hot_lead, pos: false },
    { sign: '+', lead: s.ground_clamp_socket === '+' ? 'Ground clamp' : s.hot_lead, pos: true },
  ]

  return (
    <Panel title={`${s.polarity} — ${s.process} cable setup`} source={s.sources.join(', ')}>
      <div className="ctl">
        <div>
          <label htmlFor="pol-p">Process</label>
          <select id="pol-p" value={proc} onChange={(e) => setProc(e.target.value)}>
            {setups.map((x) => <option key={x.process}>{x.process}</option>)}
          </select>
        </div>
      </div>

      <div className="sockets">
        {sockets.map((k) => (
          <div key={k.sign} className={`sock${k.pos ? ' pos' : ''}`}>
            <div className="sign">{k.sign}</div>
            <div className="lead">{k.lead}</div>
            <div className="role">
              {k.lead === 'Ground clamp' ? 'to the workpiece' : 'the live side'}
            </div>
          </div>
        ))}
      </div>

      <p className="note">
        {s.polarity === 'DCEP'
          ? 'DCEP — direct current, electrode positive. '
          : 'DCEN — direct current, electrode negative. '}
        {s.note}
        {s.shielding_gas ? ` Shielding gas: ${s.shielding_gas}.` : ' No shielding gas.'}
      </p>
    </Panel>
  )
}

/* ------------------------------------------------------- troubleshooting steps */

function TroubleshootingFlowchart(p: Props) {
  const problems: any[] = T.troubleshooting?.data?.problems ?? []
  const want = str(p, 'problem').toLowerCase()
  const initial =
    problems.find((x) => x.problem.toLowerCase().includes(want) && want) ??
    problems.find((x) => want.split(/\s+/).some((w) => w.length > 4 && x.problem.toLowerCase().includes(w))) ??
    problems[0]

  const [sel, setSel] = useState<string>(initial?.problem ?? '')
  const [done, setDone] = useState<Set<number>>(new Set())
  const cur = problems.find((x) => x.problem === sel) ?? initial
  if (!cur) return null

  const toggle = (i: number) =>
    setDone((d) => {
      const n = new Set(d)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })

  return (
    <Panel title="Work through the causes" source={`Troubleshooting, p.${cur.page}`}>
      <div className="ctl">
        <div style={{ flex: 1 }}>
          <label htmlFor="tb-p">Symptom</label>
          <select
            id="tb-p" value={sel} style={{ width: '100%' }}
            onChange={(e) => { setSel(e.target.value); setDone(new Set()) }}
          >
            {problems.map((x, i) => (
              <option key={i} value={x.problem}>{x.problem}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="steps">
        {cur.causes.map((c: any, i: number) => (
          <button
            key={i} type="button" className="step" aria-pressed={done.has(i)}
            onClick={() => toggle(i)}
            style={done.has(i) ? { opacity: 0.45, borderLeftColor: '#1e7a4c' } : undefined}
          >
            <span className="n" aria-hidden />
            <span>
              <span className="cause" style={done.has(i) ? { textDecoration: 'line-through' } : undefined}>
                {c.cause}
              </span>
              <span className="fix">{c.solution}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="note">
        Checked {done.size} of {cur.causes.length}. Work top to bottom — the manual orders
        these from most to least common.
      </p>
    </Panel>
  )
}

/* -------------------------------------------------------------- process picker */

const QUESTIONS = [
  { k: 'gas', q: 'Can you use shielding gas?', opts: ['Yes, indoors', 'No — outdoors or windy'] },
  { k: 'material', q: 'What are you welding?', opts: ['Steel', 'Stainless', 'Aluminium', 'Cast iron'] },
  { k: 'skill', q: 'How much have you welded before?', opts: ['First time', 'Some', 'A lot'] },
] as const

function ProcessSelector() {
  const rows: any[] = T.process_selection?.data?.processes ?? []
  const [a, setA] = useState<Record<string, string>>({})

  const score = (r: any) => {
    let s = 0
    const gasNeeded = /gas required/i.test(r.shielding_gas ?? '')
    if (a.gas === 'Yes, indoors' && gasNeeded) s += 2
    if (a.gas?.startsWith('No') && !gasNeeded) s += 3
    const mats = (r.materials ?? []).join(' ').toLowerCase()
    if (a.material && mats.includes(a.material.toLowerCase().slice(0, 5))) s += 3
    const lvl = (r.skill_level ?? '').toLowerCase()
    if (a.skill === 'First time' && lvl.includes('low')) s += 2
    if (a.skill === 'A lot' && lvl.includes('high')) s += 1
    return s
  }

  const answered = Object.keys(a).length === QUESTIONS.length
  const best = answered ? [...rows].sort((x, y) => score(y) - score(x))[0] : null

  return (
    <Panel title="Which process should you use" source="Selection chart">
      {QUESTIONS.map((q) => (
        <div key={q.k} style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: '#9aa2ab', display: 'block', marginBottom: 6 }}>
            {q.q}
          </label>
          <div className="picker">
            {q.opts.map((o) => (
              <button
                key={o} type="button" className="opt" aria-pressed={a[q.k] === o}
                onClick={() => setA((v) => ({ ...v, [q.k]: o }))}
              >
                <span className="name">{o}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {best && (
        <div className="match">
          <div className="name">{best.process}</div>
          <ul>
            <li>Shielding gas: {best.shielding_gas}</li>
            <li>Thickness: {best.thickness}</li>
            <li>Materials: {(best.materials ?? []).join(', ')}</li>
            {(best.strengths ?? []).slice(0, 2).map((s: string, i: number) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------ dispatcher */

export function Interactive({ component, props }: { component: string; props: Props }) {
  switch (component) {
    case 'duty_cycle_calculator': return <DutyCycleCalculator {...props} />
    case 'polarity_diagram': return <PolarityDiagram {...props} />
    case 'troubleshooting_flowchart': return <TroubleshootingFlowchart {...props} />
    case 'process_selector': return <ProcessSelector />
    default: return null
  }
}
