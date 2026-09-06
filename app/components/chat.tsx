'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { COMPONENT_META, Interactive } from './interactive'
import indexJson from '../../public/kb/index.json'

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; id: string; url: string; title: string; page: string }
  | { kind: 'component'; component: string; props: Record<string, unknown> }
  | { kind: 'diagram'; title: string; svg: string }

type Verdict = { citedPages: string[]; checked: number; miscited: string[]; fabricated: string[] }
type Work = { name: string; detail: string; live: boolean }
type Source = { url: string; title: string; page: string }

type Turn = {
  ask: string
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
  { tag: 'Set up', q: 'How do I set polarity for flux-cored? Which socket does the ground clamp go in?' },
  { tag: 'Cross-ref', q: "I'm running flux-cored on 120V at 100A. How long can I weld before resting, and where does the ground clamp go?" },
  { tag: 'Refuse', q: 'Can I run this welder off a portable generator? What size do I need?' },
]

const CATALOGUE = indexJson as { id: string; t: string; k: string }[]

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
 * A deliberately small markdown subset -- paragraphs, bullets, numbered lists, h3,
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

/* -------------------------------------------------------------- artifact */

function Artifact({
  name, source, dark, actions, children,
}: {
  name: string; source: string; dark?: boolean
  actions?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className={`artifact${dark ? ' dark' : ''}`}>
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
  const [busy, setBusy] = useState(false)
  const [spend, setSpend] = useState(0)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [filter, setFilter] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceOk, setVoiceOk] = useState(false)
  const [needsKey, setNeedsKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyError, setKeyError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recog = useRef<any>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [turns])

  useEffect(() => {
    let saved = ''
    try { saved = sessionStorage.getItem('anthropic-key') ?? '' } catch {}
    if (saved) setApiKey(saved)
    fetch('/api/health').then((r) => r.json())
      .then((h) => setNeedsKey(!h.serverKey && !saved)).catch(() => {})

    // Voice input. Someone setting up a welder has gloves on and a helmet up; typing
    // is the awkward part, not the asking. Chrome-family only, so it is additive:
    // the button simply does not appear where the API is missing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const W = window as any
    const SR = W.SpeechRecognition ?? W.webkitSpeechRecognition
    if (SR) {
      setVoiceOk(true)
      const r = new SR()
      r.continuous = false
      r.interimResults = true
      r.lang = 'en-US'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onresult = (e: any) => {
        const t = Array.from(e.results).map((x: any) => x[0].transcript).join('')
        setDraft(t)
      }
      r.onend = () => setListening(false)
      r.onerror = () => setListening(false)
      recog.current = r
    }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setZoom(null); setBrowsing(false) }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); boxRef.current?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const openPage = (doc: string, page: number) =>
    setZoom({ url: `/kb/pages/${doc}-p${String(page).padStart(2, '0')}.webp`, alt: `${doc} page ${page}` })

  const toggleMic = () => {
    if (!recog.current) return
    if (listening) { recog.current.stop(); setListening(false) }
    else { try { recog.current.start(); setListening(true) } catch { setListening(false) } }
  }

  const shown = useMemo(
    () => CATALOGUE.filter((f) =>
      !filter || (f.t + ' ' + f.id).toLowerCase().includes(filter.toLowerCase())),
    [filter],
  )

  async function ask(question: string) {
    if (!question.trim() || busy) return
    setBusy(true)
    setDraft('')

    const history = turns.flatMap((t) => [
      { role: 'user' as const, content: t.ask },
      { role: 'assistant' as const, content: t.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n') },
    ])
    const idx = turns.length
    setTurns((t) => [...t, { ask: question, blocks: [], work: [], sources: [], streaming: true }])
    const patch = (fn: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === idx ? fn(t) : t)))

    // A tool call between two text runs is a paragraph boundary. Without this the
    // streamed deltas concatenate and you get "...[p.13].Twist both cables".
    let breakText = false
    const seen = new Set<string>()

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-anthropic-key': apiKey } : {}) },
        body: JSON.stringify({ messages: [...history, { role: 'user', content: question }] }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        if (j.needsKey) {
          setNeedsKey(true); setKeyError(j.error ?? ''); setTurns((all) => all.slice(0, idx)); return
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
            const detail =
              e.name === 'get_figure' ? String(e.input.id ?? '')
              : e.name === 'get_page' ? `${e.input.doc} p.${e.input.page}`
              : e.name === 'get_table' ? String(e.input.name ?? '')
              : e.name === 'compute_duty_cycle' ? `${e.input.process} ${e.input.input_volts}V ${e.input.amps}A`
              : e.name === 'show_component' ? String(e.input.component ?? '')
              : String(e.input.title ?? '')
            patch((t) => ({
              ...t,
              work: [...t.work.map((w) => ({ ...w, live: false })), { name: e.name, detail, live: true }],
            }))
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
          } else if (e.type === 'error') {
            patch((t) => ({ ...t, error: e.message, streaming: false }))
          }
        }
      }
    } catch (err) {
      patch((t) => ({ ...t, error: (err as Error).message, streaming: false }))
    } finally {
      patch((t) => ({ ...t, streaming: false }))
      setBusy(false)
    }
  }

  const allSources = turns.flatMap((t) => t.sources)

  return (
    <>
      <div className="rail">
        <span className="mark" aria-hidden />
        <b>OmniPro 220</b>
        <span className="sub">Vulcan · item 57812</span>
        <span className="spacer" />
        <span className="meter">session <b>${spend.toFixed(3)}</b></span>
        <button className="railbtn" aria-pressed={browsing} onClick={() => setBrowsing((v) => !v)}>
          Index
        </button>
        {apiKey && !needsKey && (
          <button className="railbtn" title="Forget the key held in this tab"
            onClick={() => {
              try { sessionStorage.removeItem('anthropic-key') } catch {}
              setApiKey(''); setNeedsKey(true)
            }}>
            your key · clear
          </button>
        )}
      </div>

      <div className="layout">
        <main className="col">
          {turns.length === 0 && (
            <div className="hero">
              <div className="herotop">
                <div>
                  <h1>Ask the machine anything.</h1>
                  <p className="lede">
                    Every answer cites the page it came from, shows the figure, and has its
                    numbers checked against the manual before you see it.
                  </p>
                  <div className="badges">
                    <span className="badge"><b>52</b> pages read</span>
                    <span className="badge"><b>122</b> figures extracted</span>
                    <span className="badge"><b>4</b> tables verified</span>
                    <span className="badge">3 PDFs + the door chart</span>
                  </div>
                </div>
                <img src="/product.webp" alt="Vulcan OmniPro 220 multiprocess welder" />
              </div>

              <p className="demo-note">
                A live instrument, running on the extracted data — no API key needed. Change
                the process and watch the sockets move.
              </p>
              <Artifact name="Cable polarity" source="p.13, p.14, p.27, QSG p.2" dark>
                <div className="art-bd"><Interactive component="polarity_diagram" props={{ process: 'Flux-Cored' }} /></div>
              </Artifact>

              <div className="seeds">
                {SEEDS.map((s) => (
                  <button key={s.q} className="seed" onClick={() => ask(s.q)}>
                    <span className="tag">{s.tag}</span>
                    <span>{s.q}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <article className="turn" key={i}>
              <div className="ask">{t.ask}</div>

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
                    <Artifact key={j} name={meta.name} source={meta.source} dark>
                      <div className="art-bd"><Interactive component={b.component} props={b.props} /></div>
                    </Artifact>
                  )
                }
                return <GeneratedDiagram key={j} title={b.title} svg={b.svg} />
              })}

              {t.error && <div className="err">{t.error}</div>}
              {t.verdict && <VerdictLine v={t.verdict} />}
            </article>
          ))}
          <div ref={endRef} />
        </main>

        <aside className="aside">
          <h2>Sources in this answer</h2>
          {allSources.length === 0 ? (
            <p className="empty">
              Figures and pages the agent opens will collect here, so you can see exactly
              what an answer was built from.
            </p>
          ) : (
            <div className="srcs">
              {allSources.map((s, i) => (
                <button className="src" key={i} onClick={() => setZoom({ url: s.url, alt: s.title })}>
                  <img src={s.url} alt="" />
                  <span className="t"><b>{s.title}</b><span>{s.page}</span></span>
                </button>
              ))}
            </div>
          )}

          <h2>Knowledge index</h2>
          <div className="stat">
            <div><span>Pages</span><b>52</b></div>
            <div><span>Figures kept</span><b>122</b></div>
            <div><span>Ruled decorative</span><b>12</b></div>
            <div><span>Verified tables</span><b>4</b></div>
          </div>
          <button className="browse" onClick={() => setBrowsing(true)}>Browse everything extracted</button>
        </aside>
      </div>

      <div className="dock">
        <div className="dock-in">
          {needsKey && (
            <form className="keygate" onSubmit={(e) => {
              e.preventDefault()
              const k = apiKey.trim()
              if (!/^sk-ant-/.test(k)) { setKeyError('Anthropic keys start with sk-ant-.'); return }
              try { sessionStorage.setItem('anthropic-key', k) } catch {}
              setKeyError(''); setNeedsKey(false)
            }}>
              <p>
                <b>This demo runs on your own Anthropic key.</b> It is kept in this browser tab
                only, sent to this app&rsquo;s own API route to call Anthropic, and discarded
                when you close the tab. Nothing is stored on the server.
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key</a>
              </p>
              <div className="keyrow">
                <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-..."
                  value={apiKey} onChange={(e) => { setApiKey(e.target.value); setKeyError('') }} />
                <button type="submit">Use this key</button>
              </div>
              {keyError && <p className="keyerr">{keyError}</p>}
              <p className="keynote">
                Rather not paste a key? Clone the repo and run it locally with the key in
                <code>.env</code> — the README has a two-minute setup. The instrument above
                works either way.
              </p>
            </form>
          )}

          <form className="compose" onSubmit={(e) => { e.preventDefault(); ask(draft) }}>
            {voiceOk && (
              <button type="button" className="mic" aria-pressed={listening} onClick={toggleMic}
                title={listening ? 'Stop listening' : 'Ask out loud'} aria-label="Ask out loud">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
                </svg>
              </button>
            )}
            <textarea ref={boxRef} rows={1} value={draft}
              placeholder={listening ? 'Listening…' : 'Ask about setup, settings, a bad weld, a fault…'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft) } }} />
            <button type="submit" className="send" disabled={busy || !draft.trim()}>
              {busy ? 'Working' : 'Ask'}
            </button>
          </form>
          <p className="hint">
            Enter to send · ⌘K to focus{voiceOk ? ' · microphone for hands-free' : ''}
            {turns.length > 0 ? ' · ⌘P prints the answer' : ''}
          </p>
        </div>
      </div>

      {browsing && (
        <div className="overlay" role="dialog" aria-label="Knowledge index">
          <div className="ov-hd">
            <b>Everything extracted</b>
            <span style={{ color: '#9aa2ab' }}>{shown.length} figures</span>
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
                  <span className="meta"><b>{f.t}</b>{f.k} · {f.id}</span>
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
    </>
  )
}

/* ------------------------------------------------------------------ pieces */

function VerdictLine({ v }: { v: Verdict }) {
  const bad = v.fabricated.length > 0
  const off = v.miscited.length > 0
  return (
    <div className={`verdict${bad ? ' bad' : off ? ' warn' : ''}`}>
      <span className="sig">{bad ? 'FAIL' : off ? 'CHECK' : 'OK'}</span>
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
          {v.citedPages.join(', ') || 'the cited pages'}
        </span>
      )}
    </div>
  )
}

/**
 * Model-authored SVG. The tool schema admits only inline SVG, and the string is
 * stripped of script and event handlers before it reaches the DOM. The code toggle
 * is there because a reviewer should be able to see what the model actually drew.
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
        : <div style={{ padding: 14, background: '#fff' }} dangerouslySetInnerHTML={{ __html: clean }} />}
    </Artifact>
  )
}
