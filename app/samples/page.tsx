'use client'

/**
 * Frontend direction comparison. Four complete looks rendering identical content,
 * so the choice is about design rather than copy. Throwaway page -- once a direction
 * is picked this is deleted and the winner moves into the real app.
 *
 * Every sample also demonstrates the agreed structural changes:
 *   - 2in gutters, text running the full width between them
 *   - the answer inside a box
 *   - the key bar near the top, collapsing to a single line once set
 *   - no separate sources rail: sources are a strip beneath the answer
 */
import { useState } from 'react'
import './samples.css'

const THEMES = [
  {
    id: 'forge',
    name: 'Forge  ★ synthesis',
    blurb:
      "Blueprint's engineering discipline with Furnace's depth. Navy-to-ink on a faint " +
      'drafting grid, cyan for interface, and ember kept strictly for the electrically ' +
      'live socket. Space Grotesk wordmark and headline, IBM Plex Sans for the answer, ' +
      'IBM Plex Mono for anything the machine measures.',
  },
  {
    id: 'arc',
    name: 'Arc',
    blurb:
      'Near-black with an ember glow behind the header. Orange→amber gradient on actions, ' +
      'frosted answer card. Closest to the machine itself: dark shop, hot metal.',
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    blurb:
      'Deep navy on a faint drafting grid, cyan for interface and orange kept exclusively ' +
      'for the electrically live socket. Reads as an engineering document.',
  },
  {
    id: 'studio',
    name: 'Studio',
    blurb:
      'White with vivid orange and blue wash. Instruments stay black so the machine data ' +
      'still reads as a panel. Brightest, best on a projector in a review meeting.',
  },
  {
    id: 'furnace',
    name: 'Furnace',
    blurb:
      'Violet→rose heat gradient, glassy card, gradient headline type. The most editorial ' +
      'and the most striking; least like a tool, most like a product launch.',
  },
]

function KeyBar({ theme }: { theme: string }) {
  const [set, setSet] = useState(theme === 'blueprint' || theme === 'furnace')
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')

  if (set && !open) {
    return (
      <div className="keybar mini">
        <span className="dotok" aria-hidden />
        <span>Key active for this tab</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen(true)} style={{ background: 'transparent', border: '1px solid currentColor', opacity: 0.75 }}>
          Change
        </button>
      </div>
    )
  }
  return (
    <div className="keybar">
      <span><b>Your Anthropic key.</b> Held in memory for this tab only — never written to storage or sent anywhere but Anthropic.</span>
      <input placeholder="sk-ant-..." type="password" value={val} onChange={(e) => setVal(e.target.value)} />
      <button onClick={() => { setSet(true); setOpen(false) }}>Use this key</button>
    </div>
  )
}

function Sample({ theme }: { theme: string }) {
  return (
    <div className={`thm thm-${theme}`}>
      <div className="bar">
        {theme === 'forge'
          ? <span className="wordmark"><span className="glyph" aria-hidden>&#9889;</span>OmniPro&nbsp;220</span>
          : <b>OmniPro 220</b>}
        <span className="sub">Vulcan · item 57812</span>
        <span className="spacer" />
        <span className="meter">session $0.038</span>
      </div>

      <div className="wrap">
        {theme === 'forge' && (
          <>
            <h1 className="bigtitle">Ask the machine anything.</h1>
            <p className="subtitle">
              Every answer cites the page it came from, shows the figure, and has its
              numbers checked against the manual before you see it.
            </p>
          </>
        )}

        <KeyBar theme={theme} />

        <p className="q">How do I set polarity for flux-cored? Which socket does the ground clamp go in?</p>

        <div className="chips">
          <span className="chip2">get_table <b>polarity</b></span>
          <span className="chip2">get_figure <b>manual-p13-f1</b></span>
          <span className="chip2">show_component <b>polarity_diagram</b></span>
        </div>

        <div className="answer">
          <p className="lead">
            Flux-cored runs <b>DCEN</b> — direct current, electrode negative. Your ground clamp
            goes in the <b>positive&nbsp;(+)</b> socket.
          </p>
          <p>
            Plug the Ground Clamp Cable into the Positive (+) socket and the Wire Feed Power
            Cable into the Negative (–) socket, then twist both connectors clockwise until
            they lock. <span className="cite2">p.13</span>
          </p>
          <p>
            That is the reverse of solid-wire MIG, which runs DCEP with the ground on negative.
            If you switch between the two, the ground clamp is the one thing that moves.
            <span className="cite2">p.14</span>
          </p>

          <div className="panelbox">
            <div className="panelhd">
              <span className="nm">Cable polarity — DCEN</span>
              <span className="sr">p.13 · p.14 · p.27 · QSG p.2</span>
            </div>
            <div className="panelbd">
              <div className="socks">
                <div className="s live">
                  <div className="sign2">–</div>
                  <div className="lb">Wire Feed Power Cable</div>
                  <div className="rl">live side</div>
                </div>
                <div className="s">
                  <div className="sign2">+</div>
                  <div className="lb">Ground clamp</div>
                  <div className="rl">to the workpiece</div>
                </div>
              </div>
            </div>
          </div>

          <div className="figrow">
            <img src="/kb/figures/manual-p13-f1.webp" alt="DCEN flux-cored polarity setup, manual page 13" />
            <img src="/kb/figures/manual-p32-f6.webp" alt="LCD polarity screen" />
          </div>

          <div className="srcstrip">
            <span className="lbl">Sources</span>
            <a href="#">manual p.13</a>
            <a href="#">manual p.14</a>
            <a href="#">quick start p.2</a>
            <a href="#">polarity table</a>
          </div>

          <div className="verd">
            <span className="tick">OK</span>
            <span>4 values checked against p.13, p.14 — none invented</span>
          </div>
        </div>

        <div className="composer">
          <input placeholder="Ask about setup, settings, a bad weld, a fault…" />
          <button>Ask</button>
        </div>
      </div>
    </div>
  )
}

export default function Samples() {
  return (
    <div className="samples">
      <div className="chooser">
        <b>Pick a direction</b>
        {THEMES.map((t) => <a key={t.id} href={`#${t.id}`}>{t.name}</a>)}
        <span className="note">Same answer in all four. Tell me a name, or mix parts.</span>
      </div>

      {THEMES.map((t) => (
        <section key={t.id} id={t.id} className={`thm-${t.id}`}>
          <div className="samplehead">
            <h2>{t.name}</h2>
            <p>{t.blurb}</p>
          </div>
          <Sample theme={t.id} />
        </section>
      ))}
    </div>
  )
}
