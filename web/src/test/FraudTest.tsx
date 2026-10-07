import { useState } from 'react'
import type { FormEvent } from 'react'
import { DEFAULT_RUN } from '../lib/api'
import type { NewRun } from '../lib/api'
import { fraudEvent, inputFor, isWrong, money, narrate, OUTCOME_TEXT, outcomeOf, RUPEES_PER_STEP } from '../lib/fraud'
import { int } from '../lib/format'
import { randomBetween, useTestRun } from '../lib/testRun'
import type { Tone } from '../lib/testRun'
import type { DriftKind, Mode, Summary, Tick } from '../lib/types'
import { NumberLine } from '../components/NumberLine'
import { EndedBar, NowCard, StepControls, TestHeader, Toast, Toggle } from '../components/TestParts'
import { Card, Status, StatusIcon } from '../components/ui'
import type { StatusKind } from '../components/ui'

// Fraud starts at ₹6,000 until the fraudsters change tactics.
const FRAUD_RUN: NewRun = { ...DEFAULT_RUN, kind: 'fraud', name: 'Fraud detection test', theta: 600, start: false, speed: 2 }
const QUICK_AMOUNTS = [500, 2500, 5000, 7500, 9500]
const MIN_MOVE = 128 // fraudsters move the cutoff by at least ₹1,280, so the change is easy to see
const FEED_SIZE = 30

const TONE_STATUS: Record<Tone, StatusKind> = { good: 'good', warning: 'warning', critical: 'critical', neutral: 'neutral' }

function friendly(message: string): string {
  if (message.includes('no earlier rule')) return 'There is no earlier pattern yet. Change the tactics first, then bring the old pattern back.'
  if (message.includes('already in force')) return 'Fraud already starts at that amount.'
  return message
}

export default function FraudTest() {
  const t = useTestRun(FRAUD_RUN, friendly)
  const { live, summary: s, run, busy } = t
  const [result, setResult] = useState<Tick | null>(null)

  const send = async (x: number) => setResult(await t.send(x))
  // Any other action makes the last test's result stale, so it is cleared.
  const clearing =
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    (...args: A) => {
      setResult(null)
      fn(...args)
    }
  const next = clearing(t.next)
  const drift = clearing(t.drift)
  const patch = clearing(t.patch)
  const startOver = clearing(t.startOver)

  const last = live.ticks.length ? live.ticks[live.ticks.length - 1] : null
  const marker = last
    ? {
        value: last.x,
        label: `Last transaction: ${money(last.x)}, ${last.y_pred ? 'blocked' : 'approved'}. ${isWrong(outcomeOf(last)) ? 'That decision was wrong.' : 'That decision was right.'}`,
      }
    : null

  return (
    <div className="app">
      <TestHeader
        subtitle="Fraud detection test"
        connection={live.connection}
        status={run?.status}
        links={[
          { href: '/spam/', label: 'Spam filter test' },
          { href: '/', label: 'Back to dashboard' },
        ]}
      />

      {live.connection === 'gone' && <EndedBar onStartOver={startOver} />}

      {s && run ? (
        <>
          <Story summary={s} />
          <Scoreboard summary={s} />
          <div className="layout">
            <div className="stack">
              <Card
                id="line"
                className="order-2"
                title="Where fraud starts"
                subtitle={`Amounts from ${money(1)} to ${money(s.n)}. The engine's cutoff is blue; the real one, which it never sees, is the triangle.`}
                actions={<StateChip summary={s} />}
              >
                <NumberLine variant="fraud" summary={s} marker={marker} onPick={(theta) => drift('abrupt', theta)} />
              </Card>
              <Card
                id="feed"
                className="order-4"
                title="Transactions"
                subtitle="Newest first: the engine's decision, what the transaction really was, and what the analysts checked."
              >
                <Feed ticks={live.ticks} />
              </Card>
            </div>
            <div className="stack">
              <SendCard
                className="order-1"
                summary={s}
                busy={busy}
                running={run.status === 'running'}
                speed={run.speed ?? 2}
                result={result}
                onSend={send}
                onNext={next}
                onPlayPause={t.playPause}
                onSpeed={(speed) => run.status === 'running' && patch({ speed })}
              />
              <TacticsCard className="order-3" summary={s} busy={busy} onDrift={drift} />
              <HarderCard className="order-5" summary={s} busy={busy} onPatch={patch} onDrift={drift} onStartOver={startOver} />
            </div>
          </div>
        </>
      ) : (
        <div className="card empty">Setting up your test…</div>
      )}

      <Toast message={t.toast} onDismiss={() => t.setToast(null)} />
    </div>
  )
}

function StateChip({ summary: s }: { summary: Summary }) {
  if (s.mode === 'robust')
    return <span className="chip accent">{s.state === 'monitoring' ? 'Watching for changes' : 'Warming up'}</span>
  if (s.state === 'monitoring') return <span className="chip good">Knows the cutoff</span>
  if (s.state === 'recalling') return <span className="chip accent">Testing remembered cutoffs</span>
  return <span className="chip accent">Learning{s.candidates_left !== null ? ` · ${int(s.candidates_left)} possible` : ''}</span>
}

function Story({ summary }: { summary: Summary }) {
  const now = narrate(summary)
  return (
    <div className="story">
      <Card id="how" title="How fraud detection works here">
        <ol className="how">
          <li>
            <span className="step-num">1</span>
            <div>
              <strong>Fraud has a hidden cutoff.</strong> In this simulation every transaction at or above some amount is fraud.
              Nobody tells the engine where that cutoff is.
            </div>
          </li>
          <li>
            <span className="step-num">2</span>
            <div>
              <strong>Analysts check a few transactions.</strong> Each check rules out half of the possible cutoffs, so about 10
              checks pin it down among 1,024 possibilities.
            </div>
          </li>
          <li>
            <span className="step-num">3</span>
            <div>
              <strong>Fraudsters adapt.</strong> When they change the amounts they use, the first checked transaction that
              contradicts the engine proves it, and the engine relearns.
            </div>
          </li>
        </ol>
      </Card>
      <NowCard {...now} />
    </div>
  )
}

function Scoreboard({ summary: s }: { summary: Summary }) {
  const c = s.counters
  const tile = (label: string, value: number, note: string) => (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{int(value)}</span>
      <span className="tile-note">{note}</span>
    </div>
  )
  return (
    <div className="tiles six">
      {tile('Transactions', s.step, 'Processed so far')}
      {tile('Fraud stopped', c.confusion.tp, 'Blocked, and it was fraud')}
      {tile('Fraud missed', c.confusion.fn, 'Approved, but it was fraud')}
      {tile('Genuine blocked', c.confusion.fp, 'Blocked, but it was genuine')}
      {tile('Analyst checks', c.labels, 'Answers the engine paid for')}
      {tile('False alarms', c.false_alarms, s.noise > 0 ? 'Caused by wrong answers' : 'Proven to stay 0')}
    </div>
  )
}

function SendCard({
  summary: s,
  busy,
  running,
  speed,
  result,
  onSend,
  onNext,
  onPlayPause,
  onSpeed,
  className,
}: {
  summary: Summary
  busy: boolean
  running: boolean
  speed: number
  result: Tick | null
  onSend: (x: number) => void
  onNext: (count: number) => void
  onPlayPause: (speed: number) => void
  onSpeed: (speed: number) => void
  className?: string
}) {
  const [amount, setAmount] = useState('5000')
  const max = s.n * RUPEES_PER_STEP
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const rupees = Number(amount)
    if (Number.isFinite(rupees) && rupees > 0) onSend(inputFor(rupees, s.n))
  }
  return (
    <Card id="send" className={className} title="Test a transaction" subtitle="Send an amount and see what the engine decides.">
      <form onSubmit={submit}>
        <div className="amount-row">
          <label className="amount-input">
            <span aria-hidden="true">₹</span>
            <input
              type="number"
              inputMode="numeric"
              min={RUPEES_PER_STEP}
              max={max}
              step={RUPEES_PER_STEP}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Transaction amount in rupees"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Send
          </button>
        </div>
      </form>
      <div className="quick-amounts" aria-label="Quick amounts">
        {QUICK_AMOUNTS.map((a) => (
          <button key={a} type="button" className="btn btn-small" disabled={busy} onClick={() => onSend(inputFor(a, s.n))}>
            {money(a / RUPEES_PER_STEP)}
          </button>
        ))}
      </div>
      {result && <Result t={result} />}

      <StepControls
        noun={{ one: 'transaction', many: 'transactions' }}
        busy={busy}
        running={running}
        speed={speed}
        onNext={onNext}
        onPlayPause={onPlayPause}
        onSpeed={onSpeed}
      />
    </Card>
  )
}

function Result({ t }: { t: Tick }) {
  const o = outcomeOf(t)
  const wrong = isWrong(o)
  const detected = t.events.find((e) => e.type === 'detected')
  return (
    <div className={`result ${wrong ? 'bad' : 'good'}`} role="status" aria-live="polite">
      <span className="now-label">Your test, transaction #{int(t.step)}</span>
      <div className="result-top">
        <span className="result-amount">{money(t.x)}</span>
        <span className={`chip ${t.y_pred ? 'accent' : ''}`}>{t.y_pred ? 'Blocked' : 'Approved'}</span>
        <Status kind={wrong ? 'critical' : 'good'}>{wrong ? OUTCOME_TEXT[o] : 'Correct decision'}</Status>
      </div>
      <p>
        It really was <strong>{t.y_true ? 'fraud' : 'genuine'}</strong>.{' '}
        {t.labeled
          ? `An analyst checked it${t.y_obs !== t.y_true ? ' and gave the wrong answer' : ''}.`
          : t.query !== null
            ? `The engine is still learning, so it spent its check on ${money(t.query)} instead.`
            : 'It was not picked for a spot check.'}
      </p>
      {detected && detected.type === 'detected' && (
        <p>
          {detected.false_alarm ? (
            <>
              <strong>False alarm.</strong> The analyst's wrong answer contradicted the engine's rule, so it relearns although
              nothing changed.
            </>
          ) : (
            <>
              <strong>That check contradicted the engine's rule.</strong> It now knows for certain that fraudsters changed tactics,
              and starts relearning. Press "Next transaction" to watch.
            </>
          )}
        </p>
      )}
    </div>
  )
}

function TacticsCard({
  summary: s,
  busy,
  onDrift,
  className,
}: {
  summary: Summary
  busy: boolean
  onDrift: (kind: DriftKind, theta?: number) => void
  className?: string
}) {
  const [cutoff, setCutoff] = useState('')
  const theta = s.in_family && !s.gradual ? s.theta : null
  const canLower = theta !== null && theta - MIN_MOVE >= 1
  const canRaise = theta !== null && theta + MIN_MOVE <= s.n
  const lower = () => theta !== null && onDrift('abrupt', randomBetween(Math.max(1, Math.round(theta * 0.15)), theta - MIN_MOVE))
  const raise = () => theta !== null && onDrift('abrupt', randomBetween(theta + MIN_MOVE, s.n))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const rupees = Number(cutoff)
    if (Number.isFinite(rupees) && rupees > 0) onDrift('abrupt', inputFor(rupees, s.n))
  }
  return (
    <Card
      id="tactics"
      className={className}
      title="Fraudsters change tactics"
      subtitle="This is concept drift: the hidden cutoff moves, and the engine is not told."
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" className="btn" disabled={busy || !canLower} onClick={lower}>
          Fraudsters switch to smaller amounts
        </button>
        <button type="button" className="btn" disabled={busy || !canRaise} onClick={raise}>
          Fraudsters switch to larger amounts
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => onDrift('recurring')}>
          An old fraud pattern comes back
        </button>
        <button type="button" className="btn" disabled={busy || theta === null} onClick={() => onDrift('gradual')}>
          Fraudsters switch gradually
        </button>
      </div>
      <form onSubmit={submit} style={{ marginTop: 14 }}>
        <div className="section-label">Or choose where fraud starts</div>
        <div className="amount-row">
          <label className="amount-input">
            <span aria-hidden="true">₹</span>
            <input
              type="number"
              inputMode="numeric"
              min={RUPEES_PER_STEP}
              max={s.n * RUPEES_PER_STEP}
              step={RUPEES_PER_STEP}
              placeholder="3000"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              aria-label="New fraud cutoff in rupees"
              required
            />
          </label>
          <button type="submit" className="btn" disabled={busy}>
            Set
          </button>
        </div>
      </form>
      <p className="hint" style={{ marginTop: 8 }}>
        You can also click anywhere on the cutoff line.
      </p>
    </Card>
  )
}

function HarderCard({
  summary: s,
  busy,
  onPatch,
  onDrift,
  onStartOver,
  className,
}: {
  summary: Summary
  busy: boolean
  onPatch: (body: { mode?: Mode; p?: number; noise?: number }) => void
  onDrift: (kind: DriftKind, theta?: number) => void
  onStartOver: () => void
  className?: string
}) {
  return (
    <Card id="harder" className={className} title="Make it harder" subtitle="Each one breaks a condition the guarantee needs.">
      <ul className="action-list">
        <Toggle title="Analysts make mistakes" on={s.noise > 0} busy={busy} onChange={(on) => onPatch({ noise: on ? 0.1 : 0 })}>
          One answer in ten is wrong. The exact engine then raises false alarms; the noise-tolerant one copes.
        </Toggle>
        <Toggle title="Stop spot checks" on={s.p === 0} busy={busy} onChange={(on) => onPatch({ p: on ? 0 : 1 })}>
          Once it knows the cutoff, nobody checks again. A change of tactics then goes unnoticed forever.
        </Toggle>
        <li className="action-row">
          <h3>Fraud with no pattern</h3>
          <button type="button" className="btn btn-small" disabled={busy || !s.in_family} onClick={() => onDrift('out_of_family')}>
            Run
          </button>
          <p>Fraud becomes random. No cutoff fits, so the engine keeps starting over. Set a cutoff above to restore a pattern.</p>
        </li>
      </ul>
      <div className="section-label" style={{ marginTop: 16 }}>
        Engine
      </div>
      <div className="segmented" role="group" aria-label="Engine">
        <button type="button" aria-pressed={s.mode === 'exact'} disabled={busy} onClick={() => s.mode !== 'exact' && onPatch({ mode: 'exact' })}>
          Exact (provable)
        </button>
        <button type="button" aria-pressed={s.mode === 'robust'} disabled={busy} onClick={() => s.mode !== 'robust' && onPatch({ mode: 'robust' })}>
          Noise-tolerant
        </button>
      </div>
      <button type="button" className="btn btn-wide" style={{ marginTop: 16 }} disabled={busy} onClick={onStartOver}>
        Start over with a fresh test
      </button>
    </Card>
  )
}

function Feed({ ticks }: { ticks: Tick[] }) {
  if (ticks.length === 0) {
    return <div className="empty">No transactions yet. Send one, or press "Next transaction".</div>
  }
  const recent = ticks.slice(-FEED_SIZE).reverse()
  return (
    <ul className="feed">
      {recent.map((t) => (
        <FeedItem key={t.step} t={t} />
      ))}
    </ul>
  )
}

function FeedItem({ t }: { t: Tick }) {
  const o = outcomeOf(t)
  const wrong = isWrong(o)
  const notes = t.events.map(fraudEvent).filter((d): d is { text: string; tone: Tone } => d !== null)
  return (
    <li className={`feed-item ${wrong ? 'wrong' : ''}`}>
      <span className="feed-step">#{int(t.step)}</span>
      <div className="feed-main">
        <span className="feed-amount">{money(t.x)}</span>
        <span className={`chip ${t.y_pred ? 'accent' : ''}`}>{t.y_pred ? 'Blocked' : 'Approved'}</span>
        <Status kind={wrong ? 'critical' : 'good'}>{wrong ? OUTCOME_TEXT[o] : t.y_true ? 'Fraud stopped' : 'Genuine'}</Status>
        {t.labeled && <span className="hint">{t.y_obs !== t.y_true ? 'checked: the analyst got it wrong' : 'checked by an analyst'}</span>}
      </div>
      {t.query !== null && t.query_label !== null && (
        <div className="feed-note">
          The engine asked an analyst about {money(t.query)}: {t.query_label ? 'fraud' : 'genuine'}.
        </div>
      )}
      {notes.map((d, i) => (
        <div className="feed-note" key={i}>
          <StatusIcon kind={TONE_STATUS[d.tone]} className="icon-sm" />
          <span>{d.text}</span>
        </div>
      ))}
    </li>
  )
}
