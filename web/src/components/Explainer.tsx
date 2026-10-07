import { useState } from 'react'

const KEY = 'driftbound-explainer'

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'hidden'
  } catch {
    return true
  }
}

function saveOpen(open: boolean) {
  try {
    if (open) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'hidden')
  } catch {
    // private mode or blocked storage: the choice just won't persist
  }
}

/** Three sentences for a first-time viewer: what the page shows and what to do with it. */
export function Explainer() {
  const [open, setOpen] = useState(readOpen)
  const toggle = (next: boolean) => {
    setOpen(next)
    saveOpen(next)
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-small explainer-show" onClick={() => toggle(true)}>
        How to read this page
      </button>
    )
  }

  return (
    <section className="explainer" aria-labelledby="explainer-title">
      <div className="explainer-head">
        <h2 id="explainer-title">How to read this page</h2>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => toggle(false)}>
          Hide
        </button>
      </div>
      <ol className="explainer-steps">
        <li>
          <span className="step-num">1</span>
          <div>
            <strong>A hidden rule.</strong> Every input is a number from 1 to 1,023. A hidden threshold θ gives it the answer 1 if
            the number is at least θ, and 0 otherwise.
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div>
            <strong>The engine finds it.</strong> It pays to see correct answers, called labels. Each label halves the blue band of
            possible thresholds, so 10 labels pin down θ among 1,024.
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <strong>Then the rule changes.</strong> Use the control panel. The engine notices at the first checked mistake, never
            raises a false alarm, and relearns.
          </div>
        </li>
      </ol>
      <p className="explainer-foot">
        Prefer a real-world example? Try the <a href="/test/">fraud detection test</a> or the <a href="/spam/">spam filter test</a>: the
        same engine, with transactions or emails instead of numbers.
      </p>
    </section>
  )
}
