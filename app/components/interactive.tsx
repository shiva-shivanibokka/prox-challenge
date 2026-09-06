'use client'

/**
 * The five interactive components the agent can put on screen.
 *
 * Every one reads the verified tables rather than anything the model produced, so
 * what a user pokes at cannot drift from the manual. The agent chooses which to show
 * and seeds its starting values; it never supplies content. That is the whole reason
 * these exist alongside render_diagram: deterministic where correctness matters,
 * freehand only where it doesn't.
 *
 * They run entirely on committed JSON, so the landing page can demonstrate a working
 * instrument before anyone has entered an API key.
 */
import { useState } from 'react'
import tablesJson from '../../public/kb/tables.json'
import { SPECS, dutyCycle } from '../../lib/duty'

type Props = Record<string, unknown>
/* eslint-disable @typescript-eslint/no-explicit-any */
const T = tablesJson as Record<string, { sources: string[]; data: any }>

const str = (p: Props, k: string, d = '') => (typeof p[k] === 'string' ? (p[k] as string) : d)
const num = (p: Props, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d)

/* --------------------------------------------------------------- primitives */

/**
 * The duty cycle as the machine's own door chart draws it: a ten-minute clock with
 * the welding wedge filled. Reusing the manual's visual language means a user who
 * has seen the sticker recognises this instantly.
 */
function Clock({ percent, size = 108 }: { percent: number; size?: number }) {
  const r = size / 2 - 6
  const c = size / 2
  const a = (percent / 100) * 2 * Math.PI - Math.PI / 2
  const big = percent > 50 ? 1 : 0
  const wedge =
    percent >= 100
      ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r} Z`
      : `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${big} 1 ${c + r * Math.cos(a)} ${c + r * Math.sin(a)} Z`
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
      aria-label={`${percent}% of a ten minute period spent welding`}>
      <circle cx={c} cy={c} r={r} fill="#fff" stroke="#343a41" strokeWidth="2" />
      <path d={wedge} fill="#e8541f" />
      {Array.from({ length: 10 }, (_, i) => {
        const t = (i / 10) * 2 * Math.PI - Math.PI / 2
        return (
          <line key={i} x1={c + (r - 5) * Math.cos(t)} y1={c + (r - 5) * Math.sin(t)}
            x2={c + r * Math.cos(t)} y2={c + r * Math.sin(t)} stroke="#14161a" strokeWidth="1.5" />
        )
      })}
      <circle cx={c} cy={c} r="2.5" fill="#14161a" />
    </svg>
  )
}

/**
 * The two dinse sockets on the front of the machine, with the live one marked.
 *
 * Keyed on the process so switching remounts the SVG and replays the cable draw-in.
 * That motion is the whole point: between MIG and flux-cored the ground clamp is the
 * one thing that moves, and watching it move is more memorable than reading it.
 * Suppressed under prefers-reduced-motion by the global rule.
 */
function SocketPair({ groundOn, hotLead }: { groundOn: '+' | '-'; hotLead: string }) {
  const cells: { sign: '+' | '-'; lead: string; live: boolean }[] = [
    { sign: '-', lead: groundOn === '-' ? 'Ground clamp' : hotLead, live: groundOn === '+' },
    { sign: '+', lead: groundOn === '+' ? 'Ground clamp' : hotLead, live: groundOn === '-' },
  ]
  return (
    <div className="sockets">
      {cells.map((k) => (
        <div className="sock" key={`${k.sign}-${hotLead}-${groundOn}`}>
          <svg width="100%" height="96" viewBox="0 0 150 96" role="img"
            aria-label={`${k.sign === '+' ? 'Positive' : 'Negative'} socket: ${k.lead}`}>
            <circle className={k.live ? 'ring live' : 'ring'} cx="75" cy="42" r="26" fill="#0a0f16"
              stroke={k.live ? 'var(--hot)' : '#5a626b'} strokeWidth="3" />
            <circle cx="75" cy="42" r="13" fill="#04070c" stroke={k.live ? 'var(--hot)' : '#5a626b'} strokeWidth="2" />
            <text x="75" y="49" textAnchor="middle" fontSize="22" fontWeight="700"
              fill={k.live ? 'var(--hot)' : '#9aa2ab'} fontFamily="var(--font-mono), monospace">
              {k.sign}
            </text>
            <path className="cable"
              d={k.sign === '-' ? 'M 75 68 C 75 84, 30 80, 24 92' : 'M 75 68 C 75 84, 120 80, 126 92'}
              fill="none" stroke={k.live ? 'var(--hot)' : '#5a626b'} strokeWidth="5" strokeLinecap="round" />
          </svg>
          <div className="lead">{k.lead}</div>
          <div className="role">{k.live ? 'live side' : 'to the workpiece'}</div>
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------- duty calculator */

function DutyCycleCalculator(p: Props) {
  const [proc, setProc] = useState(str(p, 'process', 'MIG'))
  const [volts, setVolts] = useState(num(p, 'input_volts', 240))
  const spec = SPECS.find((s) => s.process === proc && s.input_volts === volts)
  const [lo, hi] = spec?.current_range_a ?? [30, 220]
  const [amps, setAmps] = useState(Math.min(Math.max(num(p, 'amps', 200), lo), hi))

  const a = Math.min(Math.max(amps, lo), hi)
  const d = dutyCycle(proc, volts, a)
  const rated = d.ok && d.rated
  const pct = rated ? (d.percent ?? 0) : 0

  return (
    <>
      <div className="ctl">
        <div>
          <label htmlFor="dc-p">Process</label>
          <select id="dc-p" value={proc} onChange={(e) => setProc(e.target.value)}>
            {[...new Set(SPECS.map((s) => s.process))].map((x) => <option key={x}>{x}</option>)}
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
          <label htmlFor="dc-a">Welding current — {a}A <span style={{ opacity: 0.6 }}>({lo}–{hi}A)</span></label>
          <input id="dc-a" type="range" min={lo} max={hi} step={5} value={a}
            onChange={(e) => setAmps(Number(e.target.value))} />
        </div>
      </div>

      <div className="readout">
        <div className="clockwrap"><Clock percent={pct} /></div>
        <div className={`cell${rated && pct !== 100 ? ' hot' : ''}`}>
          <div className="k">Rated duty cycle</div>
          <div className="v">{rated ? pct : '—'}<span className="u">{rated ? '%' : ''}</span></div>
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
      {rated && pct !== 100 && (
        <p className="note">
          Per 10 minutes. Run past this and the thermal cut-out trips — a warning screen
          appears and the machine shuts down until it cools. Leave the power switch on so
          the fan keeps running [p.23].
        </p>
      )}
      {rated && pct === 100 && <p className="note plain">Continuous. No rest period required at this current.</p>}
    </>
  )
}

/* ------------------------------------------------------------ polarity */

function PolarityDiagram(p: Props) {
  const setups: any[] = T.polarity?.data?.setups ?? []
  const [proc, setProc] = useState(
    setups.find((s) => s.process.toLowerCase() === str(p, 'process').toLowerCase())?.process ??
      setups[0]?.process ?? '',
  )
  const s = setups.find((x) => x.process === proc)
  if (!s) return null

  return (
    <>
      <div className="ctl">
        <div>
          <label htmlFor="pol-p">Process</label>
          <select id="pol-p" value={proc} onChange={(e) => setProc(e.target.value)}>
            {setups.map((x) => <option key={x.process}>{x.process}</option>)}
          </select>
        </div>
      </div>
      <SocketPair groundOn={s.ground_clamp_socket} hotLead={s.hot_lead} />
      <p className="note">
        <b>{s.polarity}</b>
        {s.polarity === 'DCEP' ? ' — direct current, electrode positive. ' : ' — direct current, electrode negative. '}
        {s.note} {s.shielding_gas ? `Shielding gas: ${s.shielding_gas}.` : 'No shielding gas.'}
      </p>
    </>
  )
}

/* ------------------------------------------------------- troubleshooting */

function TroubleshootingFlowchart(p: Props) {
  const problems: any[] = T.troubleshooting?.data?.problems ?? []
  const want = str(p, 'problem').toLowerCase()
  const initial =
    (want && problems.find((x) => x.problem.toLowerCase().includes(want))) ??
    (want && problems.find((x) => want.split(/\s+/).some((w) => w.length > 4 && x.problem.toLowerCase().includes(w)))) ??
    problems[0]

  const [sel, setSel] = useState<string>(initial?.problem ?? '')
  const [done, setDone] = useState<Set<number>>(new Set())
  const cur = problems.find((x) => x.problem === sel) ?? initial
  if (!cur) return null

  const toggle = (i: number) =>
    setDone((d) => {
      const n = new Set(d)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  return (
    <>
      <div className="ctl">
        <div style={{ flex: 1 }}>
          <label htmlFor="tb-p">Symptom</label>
          <select id="tb-p" value={sel} style={{ width: '100%' }}
            onChange={(e) => { setSel(e.target.value); setDone(new Set()) }}>
            {problems.map((x, i) => <option key={i} value={x.problem}>{x.problem}</option>)}
          </select>
        </div>
      </div>
      <div className="steps">
        {cur.causes.map((c: any, i: number) => (
          <button key={i} type="button" className={`step${done.has(i) ? ' done' : ''}`}
            aria-pressed={done.has(i)} onClick={() => toggle(i)}>
            <span className="box" aria-hidden>{done.has(i) ? '✓' : ''}</span>
            <span>
              <span className="cause">{c.cause}</span>
              <span className="fix">{c.solution}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="note plain">
        {done.size} of {cur.causes.length} checked. Work top to bottom — the manual orders
        these from most to least common.
      </p>
    </>
  )
}

/* ----------------------------------------------------------- process picker */

const QUESTIONS = [
  { k: 'gas', q: 'Can you use shielding gas?', opts: ['Yes, working indoors', 'No — outdoors or windy'] },
  { k: 'material', q: 'What are you welding?', opts: ['Steel', 'Stainless', 'Aluminium', 'Castings'] },
  { k: 'skill', q: 'How much have you welded before?', opts: ['First time', 'Some', 'A lot'] },
] as const

function ProcessSelector() {
  const rows: any[] = T.process_selection?.data?.processes ?? []
  const [a, setA] = useState<Record<string, string>>({})

  const score = (r: any) => {
    let s = 0
    const gasNeeded = /gas required/i.test(r.shielding_gas ?? '')
    if (a.gas?.startsWith('Yes') && gasNeeded) s += 2
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
    <>
      {QUESTIONS.map((q) => (
        <div key={q.k} style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: '#9aa2ab', display: 'block', marginBottom: 6 }}>{q.q}</label>
          <div className="picker">
            {q.opts.map((o) => (
              <button key={o} type="button" className="opt" aria-pressed={a[q.k] === o}
                onClick={() => setA((v) => ({ ...v, [q.k]: o }))}>
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
    </>
  )
}

/* ------------------------------------------------------ settings configurator */

const GAUGE_IN: Record<string, number> = {
  '24': 0.0239, '22': 0.0299, '20': 0.0359, '18': 0.0478,
  '16': 0.0598, '14': 0.0747, '12': 0.1046, '10': 0.1345,
}
const THICKNESSES = [
  ...Object.keys(GAUGE_IN).map((g) => ({ label: `${g} gauge`, inches: GAUGE_IN[g] })),
  { label: '3/16 in', inches: 0.1875 },
  { label: '1/4 in', inches: 0.25 },
  { label: '5/16 in', inches: 0.3125 },
  { label: '3/8 in', inches: 0.375 },
  { label: '1/2 in', inches: 0.5 },
]

/** "18 Gauge to 5/16"" -> [0.0478, 0.3125]. Returns null if it cannot be parsed. */
function parseRange(s: string): [number, number] | null {
  const side = (t: string): number | null => {
    const g = /(\d+)\s*(?:gauge|ga)/i.exec(t)
    if (g) return GAUGE_IN[g[1]] ?? null
    const f = /(\d+)\s*\/\s*(\d+)/.exec(t)
    if (f) return Number(f[1]) / Number(f[2])
    const d = /(\d*\.\d+)/.exec(t)
    return d ? Number(d[1]) : null
  }
  const parts = s.split(/\bto\b|–|—|-/i)
  if (parts.length < 2) return null
  const a = side(parts[0])
  const b = side(parts.slice(1).join(' '))
  return a != null && b != null ? [a, b] : null
}

/**
 * The OmniPro 220 is synergic: you give it wire diameter and material thickness and
 * the machine derives wire feed speed and voltage itself. The manual therefore
 * publishes no settings matrix -- "in/min" appears zero times in its text.
 *
 * So this does not invent one. It answers everything the documents *do* determine --
 * whether the process suits the job, polarity and sockets, gas, permitted wire sizes,
 * the current range -- and then tells you the sequence to make the machine work the
 * rest out. Refusing to fabricate the last two numbers is the point, not a gap.
 */
function SettingsConfigurator(p: Props) {
  const setups: any[] = T.polarity?.data?.setups ?? []
  const rows: any[] = T.process_selection?.data?.processes ?? []
  const wire = T.specs?.data?.wire ?? {}

  const [proc, setProc] = useState(str(p, 'process', 'MIG'))
  const [volts, setVolts] = useState(num(p, 'input_volts', 240))
  const [thick, setThick] = useState(str(p, 'thickness', '18 gauge'))

  const pol = setups.find((s) => s.process.toLowerCase() === proc.toLowerCase())
  const row = rows.find((r) => new RegExp(proc.split('-')[0], 'i').test(r.process))
  const spec = SPECS.find(
    (s) => s.process.toLowerCase() === (proc === 'Flux-Cored' ? 'mig' : proc.toLowerCase()) &&
      s.input_volts === volts,
  )
  const t = THICKNESSES.find((x) => x.label === thick)
  const range = row?.thickness ? parseRange(row.thickness) : null
  const fits = range && t ? t.inches >= range[0] - 1e-6 && t.inches <= range[1] + 1e-6 : null

  const diameters: string[] =
    proc === 'Flux-Cored' ? wire.flux_cored_in ?? [] : proc === 'MIG' ? wire.solid_core_in ?? [] : []

  return (
    <>
      <div className="ctl">
        <div>
          <label htmlFor="sc-p">Process</label>
          <select id="sc-p" value={proc} onChange={(e) => setProc(e.target.value)}>
            {setups.map((s) => <option key={s.process}>{s.process}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="sc-v">Input voltage</label>
          <select id="sc-v" value={volts} onChange={(e) => setVolts(Number(e.target.value))}>
            <option value={120}>120V</option>
            <option value={240}>240V</option>
          </select>
        </div>
        <div>
          <label htmlFor="sc-t">Material thickness</label>
          <select id="sc-t" value={thick} onChange={(e) => setThick(e.target.value)}>
            {THICKNESSES.map((x) => <option key={x.label}>{x.label}</option>)}
          </select>
        </div>
      </div>

      <div className="readout">
        <div className="cell">
          <div className="k">Polarity</div>
          <div className="v" style={{ fontSize: 24 }}>{pol?.polarity ?? '—'}</div>
        </div>
        <div className="cell hot">
          <div className="k">Ground clamp</div>
          <div className="v">{pol?.ground_clamp_socket ?? '—'}</div>
        </div>
        <div className="cell">
          <div className="k">Current range</div>
          <div className="v" style={{ fontSize: 22 }}>
            {spec ? `${spec.current_range_a[0]}–${spec.current_range_a[1]}` : '—'}<span className="u">A</span>
          </div>
        </div>
      </div>

      {fits === false && (
        <p className="note">
          The selection chart rates {row.process} for {row.thickness}. {thick} is outside
          that — pick another process, or check the chart before running this.
        </p>
      )}

      <p className="note plain">
        {diameters.length > 0 && <>Wire this machine takes for {proc}: {diameters.join(', ')}. </>}
        {pol?.shielding_gas ? `Gas: ${pol.shielding_gas}. ` : 'No shielding gas. '}
        {row?.thickness && <>Rated thickness: {row.thickness}.</>}
      </p>

      <p className="note">
        <b>The manual publishes no wire-speed or voltage table, and neither will I.</b> This
        welder is synergic: set the wire diameter with the left knob and the material
        thickness with the right knob, and it computes wire feed speed and voltage for you
        [p.20]. The white mark on the LCD line shows the machine&rsquo;s recommendation for
        what you entered — adjust from there by how the bead looks [p.35].
      </p>
    </>
  )
}

/* ------------------------------------------------------ guided setup walkthrough */

/**
 * The manual's setup procedure, one step at a time, with your place kept.
 *
 * Reading a twelve-step procedure off a page while holding a torch is the problem
 * this product exists to remove. Steps come from the verified setup table, so the
 * order and the wording are the manual's, not the model's, and every step carries
 * the page it came from.
 */
function SetupWalkthrough(p: Props) {
  const procs: any[] = T.setup?.data?.procedures ?? []
  const wanted = str(p, 'process', 'MIG').toLowerCase()
  const [proc, setProc] = useState(
    procs.find((x) => x.process.toLowerCase() === wanted)?.process ?? procs[0]?.process ?? '',
  )
  const [at, setAt] = useState(Math.max(0, num(p, 'step', 1) - 1))
  const cur = procs.find((x) => x.process === proc)
  if (!cur) return null

  const steps = cur.steps
  const i = Math.min(at, steps.length - 1)
  const step = steps[i]
  const done = i >= steps.length - 1

  return (
    <>
      <div className="ctl">
        <div>
          <label htmlFor="wt-p">Process</label>
          <select id="wt-p" value={proc} onChange={(e) => { setProc(e.target.value); setAt(0) }}>
            {procs.map((x) => <option key={x.process}>{x.process}</option>)}
          </select>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <label>Progress</label>
          <div className="wt-count">{i + 1} / {steps.length}</div>
        </div>
      </div>

      <div className="wt-track" role="progressbar" aria-valuenow={i + 1} aria-valuemin={1} aria-valuemax={steps.length}>
        {steps.map((_: unknown, n: number) => (
          <button key={n} className={`wt-pip${n === i ? ' at' : n < i ? ' past' : ''}`}
            aria-label={`Step ${n + 1}`} onClick={() => setAt(n)} />
        ))}
      </div>

      <div className="wt-step">
        <div className="wt-n">Step {step.n ?? i + 1}</div>
        <h4>{step.title}</h4>
        <p>{step.detail}</p>
        {step.warning && <p className="wt-warn">{step.warning}</p>}
        <div className="wt-page">Manual p.{step.page}</div>
      </div>

      <div className="wt-nav">
        <button disabled={i === 0} onClick={() => setAt(i - 1)}>Back</button>
        <button className="primary" disabled={done} onClick={() => setAt(i + 1)}>
          {done ? 'Ready to weld' : 'Done — next step'}
        </button>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ registry */

export const COMPONENT_META: Record<string, { name: string; source: string }> = {
  duty_cycle_calculator: { name: 'Duty cycle', source: 'Specifications, p.7' },
  polarity_diagram: { name: 'Cable polarity', source: 'p.13, p.14, p.27, QSG p.2' },
  troubleshooting_flowchart: { name: 'Fault checklist', source: 'Troubleshooting, p.42–44' },
  process_selector: { name: 'Which process', source: 'Selection chart' },
  settings_configurator: { name: 'Machine setup', source: 'p.7, p.13–14, p.20, selection chart' },
}

export function Interactive({ component, props }: { component: string; props: Props }) {
  switch (component) {
    case 'duty_cycle_calculator': return <DutyCycleCalculator {...props} />
    case 'polarity_diagram': return <PolarityDiagram {...props} />
    case 'troubleshooting_flowchart': return <TroubleshootingFlowchart {...props} />
    case 'process_selector': return <ProcessSelector />
    case 'settings_configurator': return <SettingsConfigurator {...props} />
    case 'setup_walkthrough': return <SetupWalkthrough {...props} />
    default: return null
  }
}
