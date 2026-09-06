'use client'

import { useEffect, useRef, useState } from 'react'
import { Interactive } from './interactive'

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; id: string; url: string; title: string; page: string }
  | { kind: 'component'; component: string; props: Record<string, unknown> }
  | { kind: 'diagram'; title: string; svg: string }

type Verdict = { citedPages: string[]; checked: number; miscited: string[]; fabricated: string[] }

type Turn = {
  ask: string
  blocks: Block[]
  work: { name: string; detail: string }[]
  verdict?: Verdict
  error?: string
  streaming: boolean
}

const SEEDS = [
  "What's the duty cycle for MIG welding at 200A on 240V?",
  'My flux-cored welds have porosity. What should I check?',
  'How do I set polarity for flux-cored? Which socket does the ground clamp go in?',
  'Can I weld aluminium with this, and what wire speed should I use?',
]

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
      const doc = /quick/i.test(m[1]) ? 'quickstart' : /chart|selection/i.test(m[1]) ? 'chart' : 'manual'
      for (const p of m[1].matchAll(/p\.?\s*(\d+)/gi)) {
        const page = Number(p[1])
        out.push(
          <button
            key={`${key}-c${i++}`} className="cite" onClick={() => onCite(doc, page)}
            title={`Open ${doc} page ${page}`}
          >
            {doc === 'manual' ? `p.${page}` : `QSG p.${page}`}
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
 * A deliberately small markdown subset -- paragraphs, bullets, numbered lists,
 * h3, bold, inline code. The agent is instructed to write plainly, so pulling in
 * a full markdown pipeline would cost more bundle than it earns.
 */
function Prose({ text, onCite }: { text: string; onCite: (d: string, p: number) => void }) {
  const nodes: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const L = list.ordered ? 'ol' : 'ul'
    nodes.push(
      <L key={`l${nodes.length}`}>
        {list.items.map((it, i) => <li key={i}>{inline(it, onCite, `l${nodes.length}i${i}`)}</li>)}
      </L>,
    )
    list = null
  }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()

    // Pipe tables. The agent reaches for one whenever it quotes several spec rows,
    // and a table really is the right shape for that -- so render it rather than
    // banning it in the prompt.
    const isRow = (s: string) => /^\s*\|.*\|\s*$/.test(s ?? '')
    if (isRow(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush()
      const cells = (r: string) =>
        r.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim())
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
      i--
      const key = nodes.length
      nodes.push(
        <div className="tablewrap" key={`t${key}`}>
          <table>
            <thead>
              <tr>{head.map((h, j) => <th key={j}>{inline(h, onCite, `th${key}-${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cl, ci) => <td key={ci}>{inline(cl, onCite, `td${key}-${ri}-${ci}`)}</td>)}
                </tr>
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

/* ------------------------------------------------------------------ the page */

export default function Chat() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [spend, setSpend] = useState(0)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
  // Bring-your-own-key. sessionStorage, not localStorage: the key dies with the tab,
  // and it is never sent anywhere except this app's own /api/chat.
  const [needsKey, setNeedsKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyError, setKeyError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  useEffect(() => {
    let saved = ''
    try { saved = sessionStorage.getItem('anthropic-key') ?? '' } catch {}
    if (saved) setApiKey(saved)
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => setNeedsKey(!h.serverKey && !saved))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(null)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const openPage = (doc: string, page: number) =>
    setZoom({
      url: `/kb/pages/${doc}-p${String(page).padStart(2, '0')}.webp`,
      alt: `${doc} page ${page}`,
    })

  async function ask(question: string) {
    if (!question.trim() || busy) return
    setBusy(true)
    setDraft('')

    const history = turns.flatMap((t) => [
      { role: 'user' as const, content: t.ask },
      { role: 'assistant' as const, content: t.blocks.filter((b) => b.kind === 'text').map((b) => (b as any).text).join('\n') },
    ])
    const idx = turns.length
    setTurns((t) => [...t, { ask: question, blocks: [], work: [], streaming: true }])

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t, i) => (i === idx ? fn(t) : t)))

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-anthropic-key': apiKey } : {}),
        },
        body: JSON.stringify({ messages: [...history, { role: 'user', content: question }] }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        if (j.needsKey) {
          setNeedsKey(true)
          setKeyError(j.error ?? '')
          setTurns((all) => all.slice(0, idx))
          return
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
            patch((t) => {
              const blocks = [...t.blocks]
              const tail = blocks[blocks.length - 1]
              if (tail?.kind === 'text') blocks[blocks.length - 1] = { kind: 'text', text: tail.text + e.delta }
              else blocks.push({ kind: 'text', text: e.delta })
              return { ...t, blocks }
            })
          } else if (e.type === 'tool') {
            const detail =
              e.name === 'get_figure' ? String(e.input.id ?? '')
              : e.name === 'get_page' ? `${e.input.doc} p.${e.input.page}`
              : e.name === 'get_table' ? String(e.input.name ?? '')
              : e.name === 'compute_duty_cycle' ? `${e.input.process} ${e.input.input_volts}V ${e.input.amps}A`
              : e.name === 'show_component' ? String(e.input.component ?? '')
              : String(e.input.title ?? '')
            patch((t) => ({ ...t, work: [...t.work, { name: e.name, detail }] }))
          } else if (e.type === 'figure') {
            patch((t) => ({ ...t, blocks: [...t.blocks, { kind: 'figure', ...e }] }))
          } else if (e.type === 'component') {
            patch((t) => ({ ...t, blocks: [...t.blocks, { kind: 'component', component: e.component, props: e.props ?? {} }] }))
          } else if (e.type === 'diagram') {
            patch((t) => ({ ...t, blocks: [...t.blocks, { kind: 'diagram', title: e.title, svg: e.svg }] }))
          } else if (e.type === 'done') {
            setSpend((s) => s + (e.costUsd ?? 0))
            patch((t) => ({ ...t, verdict: e.verdict, error: e.error, streaming: false }))
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

  return (
    <>
      <div className="rail">
        <b>OmniPro 220</b>
        <span className="sub">Vulcan · item 57812</span>
        <span className="spacer" />
        <span className="meter">
          this session <b>${spend.toFixed(3)}</b>
        </span>
        {apiKey && !needsKey && (
          <button
            className="keychip"
            title="Forget the key held in this tab"
            onClick={() => {
              try { sessionStorage.removeItem('anthropic-key') } catch {}
              setApiKey('')
              setNeedsKey(true)
            }}
          >
            your key · clear
          </button>
        )}
      </div>

      <main className="wrap">
        {turns.length === 0 && (
          <div className="start">
            <img className="machine" src="/product.webp" alt="Vulcan OmniPro 220 welder" />
            <h1>Ask the machine anything.</h1>
            <p>
              Answers come from the owner&rsquo;s manual, the quick start guide and the
              process selection chart — with the page, the figure, and the numbers checked.
            </p>
            <div className="seeds">
              {SEEDS.map((s) => (
                <button key={s} className="seed" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <article className="turn" key={i}>
            <div className="ask">{t.ask}</div>

            {t.work.length > 0 && (
              <div className="work">
                {t.work.map((w, j) => (
                  <span className="chip" key={j}>
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
                  <figure key={j}>
                    <button
                      onClick={() => setZoom({ url: b.url, alt: b.title })}
                      title="Open full size"
                    >
                      <img src={b.url} alt={b.title} />
                    </button>
                    <figcaption>
                      <span>{b.title}</span>
                      <span className="zoom">click to enlarge</span>
                      <span className="pg">{b.page}</span>
                    </figcaption>
                  </figure>
                )
              }
              if (b.kind === 'component') {
                return <Interactive key={j} component={b.component} props={b.props} />
              }
              return (
                <figure key={j}>
                  {/* Model-authored SVG. Rendered because the tool schema admits only
                      inline SVG shapes, and the string is stripped of script and
                      event handlers before it reaches the DOM. */}
                  <div
                    style={{ padding: 14, background: '#fff' }}
                    dangerouslySetInnerHTML={{
                      __html: b.svg
                        .replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
                        .replace(/javascript:/gi, ''),
                    }}
                  />
                  <figcaption>
                    <span>{b.title}</span>
                    <span className="pg">drawn for you</span>
                  </figcaption>
                </figure>
              )
            })}

            {t.error && <div className="err">{t.error}</div>}

            {t.verdict && (() => {
              const v = t.verdict!
              const bad = v.fabricated.length > 0
              const off = v.miscited.length > 0
              return (
                <div className={`verdict${bad ? ' bad' : off ? ' warn' : ''}`}>
                  <span className="mark">{bad ? '!' : off ? '~' : 'OK'}</span>
                  {bad ? (
                    <>
                      <span>not found anywhere in the manuals:</span>
                      {v.fabricated.map((u) => <span className="flag" key={u}>{u}</span>)}
                    </>
                  ) : off ? (
                    <>
                      <span>
                        {v.checked} value{v.checked === 1 ? '' : 's'} checked; these are in the
                        manuals but not on the page cited:
                      </span>
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
            })()}

          </article>
        ))}
        <div ref={endRef} />
      </main>

      <div className="dock">
        {needsKey && (
          <form
            className="keygate"
            onSubmit={(e) => {
              e.preventDefault()
              const k = apiKey.trim()
              if (!/^sk-ant-/.test(k)) {
                setKeyError('Anthropic keys start with sk-ant-.')
                return
              }
              try { sessionStorage.setItem('anthropic-key', k) } catch {}
              setKeyError('')
              setNeedsKey(false)
            }}
          >
            <p>
              <b>This demo runs on your own Anthropic key.</b> It is kept in this browser
              tab only, sent to this app&rsquo;s own API route to call Anthropic, and
              discarded when you close the tab. Nothing is stored on the server.
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                Get a key
              </a>
            </p>
            <div className="keyrow">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setKeyError('') }}
              />
              <button type="submit">Use this key</button>
            </div>
            {keyError && <p className="keyerr">{keyError}</p>}
            <p className="keynote">
              Prefer not to paste a key? Clone the repo and run it locally with the key
              in <code>.env</code> — the README has a two-minute setup.
            </p>
          </form>
        )}
        <form
          onSubmit={(e) => { e.preventDefault(); ask(draft) }}
        >
          <textarea
            rows={1}
            value={draft}
            placeholder="Ask about setup, settings, a bad weld, a fault code…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft) }
            }}
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Working' : 'Ask'}
          </button>
        </form>
      </div>

      {zoom && (
        <div className="light" onClick={() => setZoom(null)}>
          <button className="close" onClick={() => setZoom(null)}>Close · Esc</button>
          <img src={zoom.url} alt={zoom.alt} />
        </div>
      )}
    </>
  )
}
