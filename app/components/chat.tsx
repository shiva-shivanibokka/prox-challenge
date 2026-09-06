'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COMPONENT_META, Interactive, Speech } from './interactive'
import indexJson from '../../public/kb/index.json'

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; id: string; url: string; title: string; page: string }
  | { kind: 'component'; component: string; props: Record<string, unknown> }
  | { kind: 'diagram'; title: string; svg: string }

type Verdict = { citedPages: string[]; checked: number; miscited: string[]; fabricated: string[] }
type Work = { name: string; detail: string; live: boolean }
type Source = { url: string; title: string; page: string }
type Shot = { mediaType: string; data: string; url: string }

type Turn = {
  ask: string
  shots: string[]
  blocks: Block[]
  work: Work[]
  sources: Source[]
  verdict?: Verdict
  error?: string
  streaming: boolean
}

const SEEDS = [
  { tag: 'Spec', q: "What's the duty cycle for MIG welding at 200A on 240V?" },
  { tag: 'Diagnose', q: 'My flux-cored welds have porosity. What should I check?' },
  { tag: 'Set up', q: 'Walk me through setting this up for flux-cored from scratch.' },
  { tag: 'Cross-ref', q: "I'm running flux-cored on 120V at 100A. How long can I weld before resting, and where does the ground clamp go?" },
  { tag: 'Refuse', q: 'Can I run this welder off a portable generator? What size do I need?' },
]

const CATALOGUE = indexJson as { id: string; t: string; k: string }[]
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'

/* ----------------------------------------------------------- text rendering */

/** A citation is a control: it opens the page it names. */
function inline(s: string, onCite: (doc: string, page: number) => void, key: string) {
  const out: React.ReactNode[] = []
  const re = /\[([^\]]*?p\.?\s*\d+[^\]]*?)\]|\*\*(.+?)\*\*|`(.+?)`/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    if (m[1] !== undefined) {
      const doc = /quick|qsg/i.test(m[1]) ? 'quickstart'
        : /selection/i.test(m[1]) ? 'chart'
        : /door|settings chart/i.test(m[1]) ? 'door' : 'manual'
      for (const p of m[1].matchAll(/p\.?\s*(\d+)/gi)) {
        const page = Number(p[1])
        out.push(
          <button key={`${key}-c${i++}`} className="cite" onClick={() => onCite(doc, page)}
            title={`Open ${doc} page ${page}`}>
            {doc === 'manual' ? `p.${page}` : doc === 'quickstart' ? `QSG p.${page}` : doc === 'door' ? 'door chart' : 'chart'}
          </button>,
        )
        out.push(' ')
      }
    } else if (m[2] !== undefined) {
      out.push(<strong key={`${key}-b${i++}`}>{m[2]}</strong>)
    } else if (m[3] !== undefined) {
      out.push(<code key={`${key}-m${i++}`}>{m[3]}</code>)
    }
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

/**
 * A deliberately small markdown subset — paragraphs, bullets, numbered lists, h3,
 * bold, inline code and pipe tables. The agent is told to write plainly, so a full
 * markdown pipeline would cost more bundle than it earns, and writing it by hand is
 * what lets every [p.14] become a button.
 */
function Prose({ text, onCite }: { text: string; onCite: (d: string, p: number) => void }) {
  const nodes: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const L = list.ordered ? 'ol' : 'ul'
    const items = list.items
    nodes.push(
      <L key={`l${nodes.length}`}>
        {items.map((it, i) => <li key={i}>{inline(it, onCite, `l${nodes.length}i${i}`)}</li>)}
      </L>,
    )
    list = null
  }

  const lines = text.split('\n')
  const isRow = (s: string) => /^\s*\|.*\|\s*$/.test(s ?? '')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()

    if (isRow(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush()
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim())
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
      i--
      const key = nodes.length
      nodes.push(
        <div className="tablewrap" key={`t${key}`}>
          <table>
            <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, onCite, `th${key}-${j}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, onCite, `td${key}-${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    flush()
    if (!line.trim()) continue
    const h = /^#{1,4}\s+(.*)$/.exec(line)
    if (h) nodes.push(<h3 key={`h${nodes.length}`}>{inline(h[1], onCite, `h${nodes.length}`)}</h3>)
    else nodes.push(<p key={`p${nodes.length}`}>{inline(line, onCite, `p${nodes.length}`)}</p>)
  }
  flush()
  return <>{nodes}</>
}

function Artifact({ name, source, actions, children }: {
  name: string; source: string; actions?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className="artifact">
      <div className="art-hd">
        <span className="dot" aria-hidden />
        <span className="name">{name}</span>
        <span className="art-src">{source}</span>
        {actions}
      </div>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ the page */

export default function Chat() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState(false)
  const [spend, setSpend] = useState(0)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [filter, setFilter] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceIn, setVoiceIn] = useState(false)
  const [voiceOut, setVoiceOut] = useState(false)
  const [handsFree, setHandsFree] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [needsKey, setNeedsKey] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyError, setKeyError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recog = useRef<any>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [turns])

  useEffect(() => {
    // The key lives in React state and nowhere else — not sessionStorage, not
    // localStorage, not a cookie. A refresh loses it, which is the correct trade for
    // someone else's credential on a page they did not write.
    fetch('/api/health').then((r) => r.json())
      .then((h) => setNeedsKey(!h.serverKey)).catch(() => {})

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const W = window as any
    const SR = W.SpeechRecognition ?? W.webkitSpeechRecognition
    if (SR) {
      setVoiceIn(true)
      const r = new SR()
      r.continuous = false
      r.interimResults = true
      r.lang = 'en-US'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onresult = (e: any) => setDraft(Array.from(e.results).map((x: any) => x[0].transcript).join(''))
      r.onend = () => setListening(false)
      r.onerror = () => setListening(false)
      recog.current = r
    }
    if ('speechSynthesis' in window) {
      setVoiceOut(true)
      // Chrome fills the voice list asynchronously; touching it early primes it.
      window.speechSynthesis.getVoices()
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()
    }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setZoom(null); setBrowsing(false); window.speechSynthesis?.cancel() }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); boxRef.current?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  /**
   * Read an answer aloud, as a person would say it.
   *
   * Three things make Web Speech sound less like a station announcement. Pick the best
   * voice actually installed rather than the platform default, which is usually the
   * oldest one. Speak sentence by sentence so the engine puts real pauses at full
   * stops instead of racing through a wall of text. And rewrite for the ear first:
   * "[p.35]" becomes "page 35", "DCEN" becomes "D C E N", bullet marks disappear.
   */
  const speak = useCallback((raw: string) => {
    if (!('speechSynthesis' in window)) return
    const spoken = raw
      .replace(/\[([^\]]*?)p\.?\s*(\d+)([^\]]*?)\]/gi, (_m, _a, n) => `, page ${n},`)
      .replace(/\bDCE([PN])\b/g, (_m, c) => `D C E ${c}`)
      .replace(/\bCTWD\b/g, 'contact tip to work distance')
      .replace(/\bQSG\b/g, 'quick start guide')
      .replace(/(\d)\s*A\b/g, '$1 amps')
      .replace(/(\d)\s*V\b/g, '$1 volts')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/[*_`#|>]/g, '')
      .replace(/\s*\n\s*/g, '. ')
      .replace(/\.{2,}/g, '.')
      .replace(/\s+/g, ' ')
      .trim()
    if (!spoken) return

    const voices = window.speechSynthesis.getVoices()
    const best =
      voices.find((v) => /en/i.test(v.lang) && /natural|neural|premium|enhanced/i.test(v.name)) ??
      voices.find((v) => /^en-(GB|US)/i.test(v.lang) && /google/i.test(v.name)) ??
      voices.find((v) => /^en-(GB|US)/i.test(v.lang) && !/compact/i.test(v.name)) ??
      voices.find((v) => /^en/i.test(v.lang))

    window.speechSynthesis.cancel()
    const parts = spoken.match(/[^.!?]+[.!?]*/g)?.slice(0, 60) ?? [spoken]
    setSpeaking(true)
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part.trim())
      if (best) u.voice = best
      u.rate = 0.97      // a touch under default reads as explaining, not announcing
      u.pitch = 1.06     // lifts it out of the flat monotone
      u.volume = 1
      if (i === parts.length - 1) u.onend = () => setSpeaking(false)
      window.speechSynthesis.speak(u)
    })
  }, [])

  const openPage = (doc: string, page: number) =>
    setZoom({ url: `/kb/pages/${doc}-p${String(page).padStart(2, '0')}.webp`, alt: `${doc} page ${page}` })

  const toggleMic = () => {
    if (!recog.current) return
    if (listening) { recog.current.stop(); setListening(false) }
    else { try { recog.current.start(); setListening(true) } catch { setListening(false) } }
  }

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const f of Array.from(files).slice(0, 4)) {
      if (!ACCEPT.includes(f.type)) continue
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        setShots((s) => [...s, { mediaType: f.type, data: url.split(',')[1] ?? '', url }].slice(0, 4))
      }
      reader.readAsDataURL(f)
    }
  }, [])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) { e.preventDefault(); addFiles(files) }
    }
    const stop = (e: DragEvent) => { e.preventDefault() }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files)
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  const shown = useMemo(
    () => CATALOGUE.filter((f) => !filter || (f.t + ' ' + f.id).toLowerCase().includes(filter.toLowerCase())),
    [filter],
  )

  async function ask(question: string) {
    const attached = shots
    if ((!question.trim() && !attached.length) || busy) return
    setBusy(true)
    setDraft('')
    setShots([])
    window.speechSynthesis?.cancel()

    const history = turns.flatMap((t) => [
      { role: 'user' as const, content: t.ask },
      { role: 'assistant' as const, content: t.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n') },
    ])
    const idx = turns.length
    setTurns((t) => [...t, {
      ask: question || 'What do you make of this?',
      shots: attached.map((s) => s.url),
      blocks: [], work: [], sources: [], streaming: true,
    }])
    const patch = (fn: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === idx ? fn(t) : t)))

    // A tool call between two text runs is a paragraph boundary. Without this the
    // streamed deltas concatenate and you get "…[p.13].Twist both cables".
    let breakText = false
    const seen = new Set<string>()
    let spoken = ''
    setThinking(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-anthropic-key': apiKey } : {}) },
        body: JSON.stringify({
          messages: [...history, { role: 'user', content: question || 'What do you make of this photo?' }],
          images: attached.map((s) => ({ mediaType: s.mediaType, data: s.data })),
        }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        if (j.needsKey) {
          setNeedsKey(true); setKeyOpen(true); setKeyError(j.error ?? '')
          setTurns((all) => all.slice(0, idx)); setShots(attached); return
        }
        patch((t) => ({ ...t, error: j.error ?? 'Request failed', streaming: false }))
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue
          const e = JSON.parse(part.slice(6))

          if (e.type === 'text') {
            setThinking(false)
            spoken += e.delta
            const fresh = breakText
            breakText = false
            patch((t) => {
              const blocks = [...t.blocks]
              const tail = blocks[blocks.length - 1]
              if (!fresh && tail?.kind === 'text') {
                blocks[blocks.length - 1] = { kind: 'text', text: tail.text + e.delta }
              } else {
                blocks.push({ kind: 'text', text: e.delta.replace(/^\s+/, '') })
              }
              return { ...t, blocks }
            })
          } else if (e.type === 'tool') {
            breakText = true
            const d = e.input
            const detail =
              e.name === 'get_figure' ? String(d.id ?? '')
              : e.name === 'get_page' ? `${d.doc} p.${d.page}`
              : e.name === 'get_table' ? String(d.name ?? '')
              : e.name === 'view_photo' ? 'your photo'
              : e.name === 'compute_duty_cycle' ? `${d.process} ${d.input_volts}V ${d.amps}A`
              : e.name === 'show_component' ? String(d.component ?? '')
              : String(d.title ?? '')
            patch((t) => ({ ...t, work: [...t.work.map((w) => ({ ...w, live: false })), { name: e.name, detail, live: true }] }))
          } else if (e.type === 'tool_done') {
            patch((t) => ({ ...t, work: t.work.map((w) => ({ ...w, live: false })) }))
          } else if (e.type === 'figure') {
            patch((t) => ({
              ...t,
              blocks: [...t.blocks, { kind: 'figure', id: e.id, url: e.url, title: e.title, page: e.page }],
              sources: seen.has(e.url) ? t.sources
                : (seen.add(e.url), [...t.sources, { url: e.url, title: e.title, page: e.page }]),
            }))
          } else if (e.type === 'component') {
            patch((t) => ({ ...t, blocks: [...t.blocks, { kind: 'component', component: e.component, props: e.props ?? {} }] }))
          } else if (e.type === 'diagram') {
            patch((t) => ({ ...t, blocks: [...t.blocks, { kind: 'diagram', title: e.title, svg: e.svg }] }))
          } else if (e.type === 'done') {
            setSpend((s) => s + (e.costUsd ?? 0))
            patch((t) => ({ ...t, verdict: e.verdict, error: e.error, streaming: false, work: t.work.map((w) => ({ ...w, live: false })) }))
            if (handsFree) speak(spoken)
          } else if (e.type === 'error') {
            patch((t) => ({ ...t, error: e.message, streaming: false }))
          }
        }
      }
    } catch (err) {
      patch((t) => ({ ...t, error: (err as Error).message, streaming: false }))
    } finally {
      patch((t) => ({ ...t, streaming: false }))
      setThinking(false)
      setBusy(false)
    }
  }

  const newChat = () => {
    window.speechSynthesis?.cancel()
    setTurns([]); setDraft(''); setShots([]); setSpeaking(false); setThinking(false)
  }

  const keySet = Boolean(apiKey) && !keyError
  const showGate = needsKey && (!keySet || keyOpen)

  return (
    <Speech.Provider value={{ handsFree, say: speak }}>
      <div className="rail">
        <button className="wordmark" onClick={newChat} title="Start a new question">
          <span className="glyph" aria-hidden>⚡</span>OmniPro&nbsp;220
        </button>
        <span className="tag">Know your machine</span>
        <span className="spacer" />
        <span className="meter">session <b>${spend.toFixed(3)}</b></span>
        {turns.length > 0 && <button className="railbtn" onClick={newChat}>New question</button>}
        <button className="railbtn" aria-pressed={browsing} onClick={() => setBrowsing((v) => !v)}>Index</button>
      </div>

      <main className="wrap">
        {turns.length === 0 && (
          <div className="hero">
            <div className="herotop">
              <div>
                <h1 className="bigtitle">Point at the problem. Get the answer.</h1>
                <p className="subtitle">Everything in the manual. None of the reading.</p>
                <div className="badges">
                  <span className="badge"><b>52</b> pages read</span>
                  <span className="badge"><b>122</b> figures extracted</span>
                  <span className="badge"><b>5</b> tables verified</span>
                  <span className="badge">photograph your weld</span>
                </div>
              </div>
              <img src="/product-cut.webp" alt="Vulcan OmniPro 220 multiprocess welder" />
            </div>

            {needsKey && keySet && !keyOpen && (
              <div className="keygate mini">
                <span className="dotok" aria-hidden />
                <span>Key active for this tab</span>
                <span style={{ flex: 1 }} />
                <button className="ghost" onClick={() => setKeyOpen(true)}>Change</button>
              </div>
            )}

            <p className="demo-note">
              <b>Try it before you type anything.</b> The panel below is a live instrument
              running on the extracted manual data — no key needed. Change the process and
              watch the ground clamp move to the other socket.
            </p>
            <Artifact name="Cable polarity — example instrument" source="p.13 · p.14 · p.27 · QSG p.2">
              <div className="art-bd"><Interactive component="polarity_diagram" props={{ process: 'Flux-Cored' }} /></div>
            </Artifact>

            {showGate && (
              <form className="keygate" onSubmit={(e) => {
                e.preventDefault()
                const k = apiKey.trim()
                if (!/^sk-ant-/.test(k)) { setKeyError('Anthropic keys start with sk-ant-.'); return }
                setKeyError(''); setKeyOpen(false)
              }}>
                <p>
                  <b>This runs on your own Anthropic key.</b> Held in memory for this tab only —
                  never written to storage of any kind, gone the moment you refresh.
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key</a>
                </p>
                <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-..."
                  value={apiKey} onChange={(e) => { setApiKey(e.target.value); setKeyError('') }} />
                <button type="submit" className="use">Use this key</button>
                {keyError && <p className="keyerr keynote">{keyError}</p>}
                <p className="keynote">
                  Rather not paste a key? Clone the repo and run it locally with the key in
                  <code>.env</code>. The instrument above works either way.
                </p>
              </form>
            )}

            <div className="seeds">
              {SEEDS.map((s) => (
                <button key={s.q} className="seed" onClick={() => ask(s.q)}>
                  <span className="tag">{s.tag}</span><span>{s.q}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <article className="turn" key={i}>
            <div className="ask">{t.ask}</div>
            {t.shots.length > 0 && (
              <div className="askthumbs">
                {t.shots.map((u, j) => (
                  <img key={j} src={u} alt="" onClick={() => setZoom({ url: u, alt: 'your photo' })} />
                ))}
              </div>
            )}

            {t.work.length > 0 && (
              <div className="working">
                {t.work.map((w, j) => (
                  <span className={`step-chip${w.live ? ' live' : ''}`} key={j}>
                    {w.live && <span className="spin" aria-hidden />}
                    {w.name.replace(/_/g, ' ')} <b>{w.detail}</b>
                  </span>
                ))}
              </div>
            )}

            <div className="answer">
              {t.blocks.map((b, j) => {
                if (b.kind === 'text') {
                  return (
                    <div className="say" key={j}>
                      <Prose text={b.text} onCite={openPage} />
                      {t.streaming && j === t.blocks.length - 1 && <span className="caret" />}
                    </div>
                  )
                }
                if (b.kind === 'figure') {
                  return (
                    <Artifact key={j} name={b.title} source={b.page}
                      actions={<button className="act" onClick={() => setZoom({ url: b.url, alt: b.title })}>Enlarge</button>}>
                      <button className="imgbtn" onClick={() => setZoom({ url: b.url, alt: b.title })}>
                        <img src={b.url} alt={b.title} />
                      </button>
                    </Artifact>
                  )
                }
                if (b.kind === 'component') {
                  const meta = COMPONENT_META[b.component] ?? { name: b.component, source: '' }
                  return (
                    <Artifact key={j} name={meta.name} source={meta.source}>
                      <div className="art-bd"><Interactive component={b.component} props={b.props} /></div>
                    </Artifact>
                  )
                }
                return <GeneratedDiagram key={j} title={b.title} svg={b.svg} />
              })}

              {t.streaming && t.blocks.length === 0 && (
                <div className="thinking">
                  <span className="dots" aria-hidden><i /><i /><i /></span>
                  {t.work.length
                    ? `Reading ${t.work[t.work.length - 1].detail || 'the manual'}…`
                    : 'Thinking…'}
                </div>
              )}
              {t.error && <div className="err">{t.error}</div>}

              {t.sources.length > 0 && (
                <div className="srcstrip">
                  <span className="lbl">SOURCES</span>
                  {t.sources.map((s, j) => (
                    <button key={j} onClick={() => setZoom({ url: s.url, alt: s.title })}>
                      <img src={s.url} alt="" />{s.page}
                    </button>
                  ))}
                </div>
              )}
              {t.verdict && <VerdictLine v={t.verdict} />}
            </div>
          </article>
        ))}
        <div ref={endRef} />

        <footer className="colophon">
          <span>Built by <b>Shivani Bokka</b></span>
          <span className="sep">·</span>
          <a href="https://github.com/shiva-shivanibokka/prox-challenge" target="_blank" rel="noreferrer">Source</a>
          <span className="sep">·</span>
          <span>Answers come from the Vulcan OmniPro 220 manuals. Verify at the machine.</span>
        </footer>
      </main>

      <div className="dock">
        <div className="dockbar">
          {voiceOut && (
            <button className="toggle" aria-pressed={handsFree}
              title="Read every answer aloud — for when your helmet is down and your gloves are on"
              onClick={() => {
                const n = !handsFree
                setHandsFree(n)
                if (!n) { window.speechSynthesis.cancel(); setSpeaking(false) }
              }}>
              <span className="sw" aria-hidden />
              Hands-free {handsFree ? 'on' : 'off'}
            </button>
          )}
          {speaking && (
            <button className="toggle" onClick={() => { window.speechSynthesis.cancel(); setSpeaking(false) }}>
              <span className="wave" aria-hidden><i /><i /><i /><i /><i /></span>
              Stop reading
            </button>
          )}
        </div>

        {listening && (
          <div className="hearing-bar">
            <span className="wave" aria-hidden><i /><i /><i /><i /><i /></span>
            Listening — say your question, then pause
          </div>
        )}

        {shots.length > 0 && (
          <div className="pending">
            {shots.map((s, i) => (
              <figure key={i}>
                <img src={s.url} alt="" />
                <button aria-label="Remove photo" onClick={() => setShots((v) => v.filter((_, j) => j !== i))}>✕</button>
              </figure>
            ))}
          </div>
        )}

        <form className={`compose${listening ? ' hearing' : ''}`} onSubmit={(e) => { e.preventDefault(); ask(draft) }}>
          <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
          <button type="button" className="iconbtn" onClick={() => fileRef.current?.click()}
            title="Photograph your weld — drag, paste or browse" aria-label="Attach a photo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
              <circle cx="12" cy="12.5" r="3.4" />
            </svg>
          </button>
          {voiceIn && (
            <button type="button" className="iconbtn" aria-pressed={listening} onClick={toggleMic}
              title={listening ? 'Stop listening' : 'Ask out loud'} aria-label="Ask out loud">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
                <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
              </svg>
            </button>
          )}
          <textarea ref={boxRef} rows={1} value={draft}
            placeholder={listening ? 'Listening…' : 'Ask about setup, settings, a bad weld — or drop in a photo'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft) } }} />
          <button type="submit" className="send" disabled={busy || (!draft.trim() && !shots.length)}>
            {busy ? 'Working' : 'Ask'}
          </button>
        </form>
        <p className="hint">
          Enter to send · ⌘K to focus · drag or paste a photo of your weld
          {voiceIn ? ' · mic for hands-free' : ''}
        </p>
      </div>

      {browsing && (
        <div className="overlay" role="dialog" aria-label="Knowledge index">
          <div className="ov-hd">
            <b>Everything extracted</b>
            <span style={{ color: 'var(--text-3)' }}>{shown.length} figures</span>
            <input placeholder="Filter by name or page…" value={filter}
              onChange={(e) => setFilter(e.target.value)} autoFocus />
            <button className="close" onClick={() => setBrowsing(false)}>Close · Esc</button>
          </div>
          <div className="ov-bd">
            <div className="grid">
              {shown.map((f) => (
                <button className="card" key={f.id}
                  onClick={() => setZoom({ url: `/kb/figures/${f.id}.webp`, alt: f.t })}>
                  <img src={`/kb/figures/${f.id}.webp`} alt="" loading="lazy" />
                  <span className="meta"><b>{f.t}</b><span>{f.k} · {f.id}</span></span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {zoom && (
        <div className="light" onClick={() => setZoom(null)}>
          <button className="close" onClick={() => setZoom(null)}>Close · Esc</button>
          <img src={zoom.url} alt={zoom.alt} />
        </div>
      )}
    </Speech.Provider>
  )
}

/* ------------------------------------------------------------------ pieces */

function VerdictLine({ v }: { v: Verdict }) {
  const bad = v.fabricated.length > 0
  const off = v.miscited.length > 0
  return (
    <div className={`verdict${bad ? ' bad' : off ? ' warn' : ''}`}>
      <span className="sig">{bad ? 'FAIL' : off ? 'CHECK' : 'VERIFIED'}</span>
      {bad ? (
        <>
          <span>not found anywhere in the manuals:</span>
          {v.fabricated.map((u) => <span className="flag" key={u}>{u}</span>)}
        </>
      ) : off ? (
        <>
          <span>{v.checked} values checked; these are in the manuals but not on the page cited:</span>
          {v.miscited.map((u) => <span className="flag" key={u}>{u}</span>)}
        </>
      ) : (
        <span>
          {v.checked} value{v.checked === 1 ? '' : 's'} checked against{' '}
          {v.citedPages.join(', ') || 'the cited pages'} — nothing invented
        </span>
      )}
    </div>
  )
}

/**
 * Model-authored SVG. The tool schema admits only inline SVG, and the string is
 * stripped of script and event handlers before it reaches the DOM. The code toggle is
 * there because a reviewer should be able to see what the model actually drew.
 */
function GeneratedDiagram({ title, svg }: { title: string; svg: string }) {
  const [code, setCode] = useState(false)
  const clean = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
  return (
    <Artifact name={title} source="drawn for this answer"
      actions={<button className="act" onClick={() => setCode((c) => !c)}>{code ? 'Diagram' : 'Code'}</button>}>
      {code
        ? <pre>{clean}</pre>
        : <div style={{ padding: 16, background: '#fff' }} dangerouslySetInnerHTML={{ __html: clean }} />}
    </Artifact>
  )
}
