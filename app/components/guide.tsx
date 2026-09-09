/*
 * The manual for the manual. Static prose — no state, no fetch, no API calls.
 * Rendered inside the same overlay shell the figure index uses.
 *
 * Left column is for whoever owns the welder. Right column is for whoever is
 * reading the code. Neither one has to read the other.
 */

const USING = [
  {
    h: 'Ask in your own words',
    p: <>You do not need the right term. <em>&ldquo;It looks like tiny craters&rdquo;</em> lands on the
       same page as <em>porosity</em>. Duty cycle, wire size, gas, polarity, error codes,
       what the knobs do — if it is in the three manuals, ask for it plainly.</>,
  },
  {
    h: 'Show it your weld',
    p: <>Drag a photo onto the question box, paste one, or browse. It opens your picture,
       puts the manual&rsquo;s own bead chart beside it, and tells you which of the six it
       matches — including when the answer is that your weld looks fine.</>,
  },
  {
    h: 'Use the panels, not just the words',
    p: <>Answers arrive with working instruments: a duty-cycle clock, a cable diagram you can
       switch between processes, a fault checklist you can tick through. They read the
       manual&rsquo;s verified tables, so what you click cannot drift from what is printed.</>,
  },
  {
    h: 'Check anything you doubt',
    p: <>Every <code>[p.14]</code> is a button — it opens that page of the manual. The green
       <b> verified</b> strip under an answer means every number in it was matched back to
       the page it cited, by code, not by the model promising.</>,
  },
  {
    h: 'Gloves on, helmet down',
    p: <>The mic button listens. Hands-free reads answers back. In the guided setup it reads
       the step you are standing on and re-reads when you advance, so you never have to put
       a hand back on the keyboard.</>,
  },
]

const WONT = [
  <>It will not <b>invent a duty cycle</b> for an amperage the manual does not publish. It
   gives you the two rated points either side and says the manual is silent between them.
   Guessing that number is how a welder gets cooked.</>,
  <>It will not <b>answer past the manual</b>. Ask about a portable generator and it tells you
   the word never appears in any of the documents — then hands you the current-draw table so
   you can size one yourself.</>,
  <>It will not <b>find a fault in every photo</b>. Show it the machine and it says that is not
   a weld. A tool that diagnoses everything is flattering you, not helping you.</>,
  <>It does not <b>remember anything</b>. Refresh and the conversation is gone. No history, no
   account, and your API key is never written to disk or to your browser.</>,
]

const PIPELINE = [
  {
    h: 'Read the documents once, offline',
    p: <>Three PDFs plus the photograph of the chart inside the door. All of it is processed
       on my machine and the results committed to the repo, so nothing is parsed when you
       load this page and nobody pays to rebuild it.</>,
  },
  {
    h: 'Find the figures the hard way',
    p: <>The drawings are not stored as pictures — they are thousands of vector lines. Asking a
       PDF library for the images on page 47 returns <b>zero</b>; asking for the drawings
       returns <b>26,144</b>. So every line is painted onto a coarse grid, touching blobs are
       joined up, and those page regions are re-rendered. 134 figures found that way, 122 kept.</>,
  },
  {
    h: 'Transcribe what text cannot reach',
    p: <>The process selection chart contains zero characters of text — a text-only system
       cannot see it at all. A vision pass turned it into 54 rows of data. Five tables were
       rebuilt the same way, then checked: every number has to appear literally in that
       page&rsquo;s own text or the build reports it.</>,
  },
  {
    h: 'Skip search entirely',
    p: <>The whole corpus is 51 pages. It fits inside a cached prompt, so there is no index to
       search and nothing to rank. The model reads a complete list of every figure and asks
       for one by name. It cannot miss a figure, because nothing was filtered out first.</>,
  },
  {
    h: 'Check the answer afterwards',
    p: <>A pass with no model in it — about a millisecond — pulls every quantity out of the
       answer and matches it against the page cited. A <b>fabricated</b> number, one that
       exists nowhere, is treated differently from a <b>miscited</b> one that is real but on
       another page. It caught a genuine error during development.</>,
  },
]

export function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" role="dialog" aria-label="How this works">
      <div className="ov-hd">
        <b>How this works</b>
        <span style={{ color: 'var(--text-3)' }}>using it, and what is underneath</span>
        <button className="close" onClick={onClose}>Close · Esc</button>
      </div>
      <div className="ov-bd">
        <div className="guide">
          <section>
            <h2>Using it</h2>
            <ol className="gsteps">
              {USING.map((s) => (
                <li key={s.h}><h3>{s.h}</h3><p>{s.p}</p></li>
              ))}
            </ol>

            <h2 className="gsecond">What it refuses to do</h2>
            <ul className="gwont">
              {WONT.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </section>

          <section>
            <h2>What is underneath</h2>
            <ol className="gsteps gpipe">
              {PIPELINE.map((s) => (
                <li key={s.h}><h3>{s.h}</h3><p>{s.p}</p></li>
              ))}
            </ol>

            <h2 className="gsecond">Where it is weak</h2>
            <ul className="gwont">
              <li>One weld test out of fourteen fails on any given run, and which one varies.
                  The two hardest reference beads differ only in relative width. I stopped
                  there rather than overfit to six line drawings.</li>
              <li>The check verifies numbers, not claims. An answer saying <em>use argon</em>{' '}
                  passes unexamined.</li>
              <li>Two numbers in the setup table could not be confirmed against their page.
                  They are marked unverified rather than quietly dropped.</li>
            </ul>

            <p className="gnote">
              The reasoning behind every one of these decisions — including the ones that took
              two attempts — is written out in the README.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
