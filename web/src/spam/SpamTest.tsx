import { useState } from 'react'
import type { FormEvent } from 'react'
import { DEFAULT_RUN } from '../lib/api'
import type { NewRun } from '../lib/api'
import { int } from '../lib/format'
import {
  DECISION_TEXT,
  feedbackOf,
  fixedDecision,
  folder,
  narrateSpam,
  score,
  spamEvent,
  START_CUTOFF,
  subjectFor,
} from '../lib/spam'
import { decisionOf, isWrongDecision, randomBetween, useTestRun } from '../lib/testRun'
import type { Decision, Tone } from '../lib/testRun'
import type { DriftKind, Mode, Summary, Tick } from '../lib/types'
import { NumberLine } from '../components/NumberLine'
import { EndedBar, NowCard, StepControls, TestHeader, Toast, Toggle } from '../components/TestParts'
import { Card, Status, StatusIcon } from '../components/ui'
import type { StatusKind } from '../components/ui'

const REPORT_SHARE = 0.2 // users give a verdict on one email in five
// Spam starts at score 600 until spammers change their wording.
const SPAM_RUN: NewRun = {
  ...DEFAULT_RUN,
  kind: 'spam',
  name: 'Spam filter test',
  theta: START_CUTOFF,
  p: REPORT_SHARE,
  start: false,
  speed: 2,
}
const QUICK_SCORES = [150, 400, 550, 700, 900]
const SHARES = [1, 0.2, 0.05]
const MIN_MOVE = 128 // spammers move the cutoff by at least 128 points, so the change is easy to see
const FEED_SIZE = 30

const TONE_STATUS: Record<Tone, StatusKind> = { good: 'good', warning: 'warning', critical: 'critical', neutral: 'neutral' }

function friendly(message: string): string {
  if (message.includes('no earlier rule')) return 'There is no earlier campaign yet. Change the wording first, then bring the old campaign back.'
  if (message.includes('already in force')) return 'Spam already starts at that score.'
  return message
}

type Counts = Record<Decision, number>
const zero = (): Counts => ({ tp: 0, fp: 0, tn: 0, fn: 0 })
interface Tally {
  runId: string | null
  upTo: number // the highest step counted
  emails: number
  engine: Counts
  fixed: Counts
}
const emptyTally = (runId: string | null): Tally => ({ runId, upTo: 0, emails: 0, engine: zero(), fixed: zero() })

/**
 * The engine against a filter that never adapts, counted over the same emails:
 * every email this page has seen since it opened.
 */
function useComparison(runId: string | null, ticks: Tick[]): Tally {
  const [tally, setTally] = useState<Tally>(() => emptyTally(runId))
  const updated = advance(tally, runId, ticks)
  // New emails arrived: keep the counts for the next render (React allows this guarded update).
  if (updated !== tally) setTally(updated)
  return updated
}

/** Count the emails not counted yet; the same object back when there are none. */
function advance(prev: Tally, runId: string | null, ticks: Tick[]): Tally {
  const base = prev.runId === runId ? prev : emptyTally(runId)
  const fresh = ticks.filter((t) => t.step > base.upTo)
  if (fresh.length === 0) return base
  const next = { ...base, engine: { ...base.engine }, fixed: { ...base.fixed } }
  for (const t of fresh) {
    next.engine[decisionOf(t)] += 1
    next.fixed[fixedDecision(t)] += 1
    next.emails += 1
  }
  next.upTo = fresh[fresh.length - 1].step
  return next
}

export default function SpamTest() {
  const t = useTestRun(SPAM_RUN, friendly)
  const { live, summary: s, run, busy } = t
  const [result, setResult] = useState<Tick | null>(null)
  const tally = useComparison(run?.id ?? null, live.ticks)

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
        label: `Last email: score ${score(last.x)}, put in the ${folder(last.y_pred).toLowerCase()}. ${isWrongDecision(decisionOf(last)) ? 'That was wrong.' : 'That was right.'}`,
      }
    : null

  return (
    <div className="app">
      <TestHeader
        subtitle="Spam filter test"
        connection={live.connection}
        status={run?.status}
        links={[
          { href: '/test/', label: 'Fraud detection test' },
          { href: '/', label: 'Back to dashboard' },
        ]}
      />

      {live.connection === 'gone' && <EndedBar onStartOver={startOver} />}

      {s && run ? (
        <>
          <div className="story">
            <Card id="how" title="How spam filtering works here">
              <ol className="how">
                <li>
                  <span className="step-num">1</span>
                  <div>
                    <strong>Every email already has a spam score.</strong> A separate filter scores each email from 1 to{' '}
                    {int(s.n)}. Emails at or above a cutoff go to the spam folder; the rest go to the inbox.
                  </div>
                </li>
                <li>
                  <span className="step-num">2</span>
                  <div>
                    <strong>The engine keeps the cutoff right.</strong> It does not score emails. A reviewer checks an email at the
                    score it picks, and each answer rules out half of the possible cutoffs: about 10 reviews pin it down.
                  </div>
                </li>
                <li>
                  <span className="step-num">3</span>
                  <div>
                    <strong>Spammers change their wording.</strong> Then the right cutoff moves. The first user report that
                    contradicts the cutoff proves it, and the engine relearns.
                  </div>
                </li>
              </ol>
            </Card>
            <NowCard {...narrateSpam(s)} />
          </div>

          <Comparison tally={tally} summary={s} />

          <div className="layout">
            <div className="stack">
              <Card
                id="line"
                className="order-2"
                title="The cutoff score"
                subtitle={`Scores from 1 to ${int(s.n)}. The engine's cutoff is blue; where spam really starts, which it never sees, is the triangle. The dashed line is the filter that never adapts.`}
                actions={<StateChip summary={s} />}
              >
                <NumberLine
                  variant="spam"
                  summary={s}
                  marker={marker}
                  reference={{ value: START_CUTOFF, label: `Fixed filter: cutoff ${score(START_CUTOFF)}` }}
                  onPick={(theta) => drift('abrupt', theta)}
                />
              </Card>
              <Card
                id="feed"
                className="order-4"
                title="Recent emails"
                subtitle="Newest first. Subject lines are simulated: they suit the score, not the truth."
              >
                <Feed ticks={live.ticks} />
              </Card>
            </div>
            <div className="stack">
              <Card id="send" className="order-1" title="Send an email" subtitle="Pick its spam score and see where it goes.">
                <SendForm n={s.n} busy={busy} onSend={send} />
                {result && <Result t={result} />}
                <StepControls
                  noun={{ one: 'email', many: 'emails' }}
                  busy={busy}
                  running={run.status === 'running'}
                  speed={run.speed ?? 2}
                  onNext={next}
                  onPlayPause={t.playPause}
                  onSpeed={(speed) => run.status === 'running' && patch({ speed })}
                />
              </Card>
              <WordingCard className="order-3" summary={s} busy={busy} onDrift={drift} />
              <HarderCard className="order-5" summary={s} busy={busy} onPatch={patch} onDrift={drift} onStartOver={startOver} />
              <Card id="about" className="order-6" title="About this simulation">
                <ul className="how">
                  <li>The spam scores come from a separate filter; DriftBound only chooses the cutoff.</li>
                  <li>In this simulation there is always an email at the score the engine asks a reviewer to check.</li>
                  <li>
                    Real scores are not perfectly ordered, so some spam scores low and some real mail scores high: that is what the
                    noise-tolerant engine is for.
                  </li>
                </ul>
              </Card>
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
  if (s.state === 'monitoring') return <span className="chip good">Cutoff known</span>
  if (s.state === 'recalling') return <span className="chip accent">Retrying old cutoffs</span>
  return <span className="chip accent">Learning{s.candidates_left !== null ? ` · ${int(s.candidates_left)} possible` : ''}</span>
}

/** The main thing to see: the adapting engine against a filter that never adapts, on the same emails. */
function Comparison({ tally, summary: s }: { tally: Tally; summary: Summary }) {
  const rows: { key: Decision; label: string; good: boolean }[] = [
    { key: 'tp', label: 'Spam caught', good: true },
    { key: 'fn', label: 'Spam delivered to the inbox', good: false },
    { key: 'fp', label: 'Real mail sent to spam', good: false },
  ]
  const missed = (c: Counts) => c.fn + c.fp
  const gap = missed(tally.fixed) - missed(tally.engine)
  return (
    <Card
      id="compare"
      title="DriftBound against a filter that never adapts"
      subtitle={`The same ${int(tally.emails)} emails, filed two ways. The fixed filter was tuned perfectly on day one (cutoff ${score(START_CUTOFF)}) and never changes.`}
      actions={
        tally.emails > 0 ? (
          <span className={`chip ${gap > 0 ? 'good' : gap < 0 ? 'warn' : ''}`}>
            {gap > 0 ? `${int(gap)} fewer misfiled with DriftBound` : gap < 0 ? `${int(-gap)} more misfiled with DriftBound` : 'Level so far'}
          </span>
        ) : undefined
      }
    >
      <div className="compare">
        {(['engine', 'fixed'] as const).map((who) => (
          <div key={who} className={`compare-col ${who}`}>
            <h3>{who === 'engine' ? 'DriftBound (adapts)' : `Fixed filter (cutoff ${score(START_CUTOFF)})`}</h3>
            <dl>
              {rows.map((r) => (
                <div key={r.key} className={!r.good && tally[who][r.key] > 0 ? 'bad' : ''}>
                  <dt>{r.label}</dt>
                  <dd className="num">{int(tally[who][r.key])}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        Counted in this browser over every email since the page opened. While it learns, DriftBound files some emails wrongly
        that the day-one filter gets right; after spammers change their wording, the fixed filter keeps misfiling. Reviews and
        reports so far: {int(s.counters.labels)}. False alarms: {int(s.counters.false_alarms)}.
      </p>
    </Card>
  )
}

function SendForm({ n, busy, onSend }: { n: number; busy: boolean; onSend: (x: number) => void }) {
  const [value, setValue] = useState('550')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = Math.round(Number(value))
    if (Number.isFinite(v)) onSend(Math.min(n, Math.max(1, v)))
  }
  return (
    <>
      <form onSubmit={submit}>
        <div className="amount-row">
          <label className="amount-input score-input">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={n}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Spam score of the email"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Send
          </button>
        </div>
      </form>
      <div className="quick-amounts" aria-label="Quick scores">
        {QUICK_SCORES.map((x) => (
          <button key={x} type="button" className="btn btn-small" disabled={busy} onClick={() => onSend(Math.min(n, x))}>
            Score {score(x)}
          </button>
        ))}
      </div>
    </>
  )
}

function Result({ t }: { t: Tick }) {
  const d = decisionOf(t)
  const wrong = isWrongDecision(d)
  const fixed = fixedDecision(t)
  const detected = t.events.find((e) => e.type === 'detected')
  const feedback = feedbackOf(t)
  return (
    <div className={`result ${wrong ? 'bad' : 'good'}`} role="status" aria-live="polite">
      <span className="now-label">Your email, #{int(t.step)}</span>
      <div className="result-top">
        <span className="result-amount">Score {score(t.x)}</span>
        <span className={`chip ${t.y_pred ? 'accent' : ''}`}>{folder(t.y_pred)}</span>
        <Status kind={wrong ? 'critical' : 'good'}>{wrong ? DECISION_TEXT[d] : 'Filed correctly'}</Status>
      </div>
      <p>
        <em>“{subjectFor(t.x, t.step)}”</em> (simulated subject). It really was <strong>{t.y_true ? 'spam' : 'real mail'}</strong>.{' '}
        {feedback
          ? `${feedback}.`
          : t.query !== null
            ? `The engine is still learning, so a reviewer checked an email scoring ${score(t.query)} instead.`
            : 'No user reported on it.'}
      </p>
      <p>
        The fixed filter would have put it in the <strong>{folder(t.x >= START_CUTOFF ? 1 : 0).toLowerCase()}</strong>:{' '}
        {isWrongDecision(fixed) ? 'wrongly.' : 'correctly.'}
      </p>
      {detected && detected.type === 'detected' && (
        <p>
          {detected.false_alarm ? (
            <>
              <strong>False alarm.</strong> A mistaken report contradicted the cutoff, so the engine relearns although nothing
              changed.
            </>
          ) : (
            <>
              <strong>That report contradicted the cutoff.</strong> The engine now knows for certain that spammers changed their
              wording, and starts relearning. Press "Next email" to watch.
            </>
          )}
        </p>
      )}
    </div>
  )
}

function WordingCard({
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
  const lower = () => theta !== null && onDrift('abrupt', randomBetween(Math.max(1, Math.round(theta * 0.3)), theta - MIN_MOVE))
  const raise = () => theta !== null && onDrift('abrupt', randomBetween(theta + MIN_MOVE, s.n))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = Math.round(Number(cutoff))
    if (Number.isFinite(v)) onDrift('abrupt', Math.min(s.n, Math.max(1, v)))
  }
  return (
    <Card
      id="wording"
      className={className}
      title="Spammers change their wording"
      subtitle="This is concept drift: where spam starts on the score line moves, and the engine is not told."
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" className="btn" disabled={busy || !canLower} onClick={lower}>
          Spam slips in with lower scores
        </button>
        <button type="button" className="btn" disabled={busy || !canRaise} onClick={raise}>
          Spam moves to higher scores
        </button>
        <button type="button" className="btn" disabled={busy || theta === null} onClick={() => onDrift('gradual')}>
          Spammers reword gradually
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => onDrift('recurring')}>
          An old campaign returns
        </button>
      </div>
      <form onSubmit={submit} style={{ marginTop: 14 }}>
        <div className="section-label">Or choose where spam starts</div>
        <div className="amount-row">
          <label className="amount-input score-input">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={s.n}
              step={1}
              placeholder="350"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              aria-label="New spam cutoff score"
              required
            />
          </label>
          <button type="submit" className="btn" disabled={busy}>
            Set
          </button>
        </div>
      </form>
      <p className="hint" style={{ marginTop: 8 }}>
        You can also click anywhere on the cutoff line. When an old campaign returns, the engine tries the cutoffs it remembers
        first, so it needs only 2 to 5 reviews.
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
      <div className="field">
        <div className="field-row">
          <label htmlFor="share">Share of emails users report on</label>
        </div>
        <div className="segmented" role="group" id="share" aria-label="Share of emails users report on">
          {SHARES.map((v) => (
            <button key={v} type="button" aria-pressed={s.p === v} disabled={busy} onClick={() => s.p !== v && onPatch({ p: v })}>
              {Math.round(v * 100)}%
            </button>
          ))}
        </div>
        <span className="hint">
          A report is “Report spam” on an email in the inbox, or “Not spam” on one in the spam folder. Fewer reports means a change
          is caught later.
        </span>
      </div>
      <ul className="action-list">
        <Toggle title="Users mis-report" on={s.noise > 0} busy={busy} onChange={(on) => onPatch({ noise: on ? 0.1 : 0 })}>
          One verdict in ten is wrong. The exact engine then raises false alarms; the noise-tolerant one copes.
        </Toggle>
        <Toggle title="Nobody reports" on={s.p === 0} busy={busy} onChange={(on) => onPatch({ p: on ? 0 : REPORT_SHARE })}>
          Once the cutoff is set, nobody reports anything. A change of wording then goes unnoticed forever.
        </Toggle>
        <li className="action-row">
          <h3>Spam with no score pattern</h3>
          <button type="button" className="btn btn-small" disabled={busy || !s.in_family} onClick={() => onDrift('out_of_family')}>
            Run
          </button>
          <p>Whether an email is spam stops depending on its score. No cutoff fits, so the engine keeps starting over. Set a cutoff above to restore a pattern.</p>
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
  if (ticks.length === 0) return <div className="empty">No emails yet. Send one, or press "Next email".</div>
  return (
    <ul className="feed">
      {ticks
        .slice(-FEED_SIZE)
        .reverse()
        .map((t) => (
          <FeedItem key={t.step} t={t} />
        ))}
    </ul>
  )
}

function FeedItem({ t }: { t: Tick }) {
  const d = decisionOf(t)
  const wrong = isWrongDecision(d)
  const fixed = fixedDecision(t)
  const feedback = feedbackOf(t)
  const notes = t.events.map(spamEvent).filter((x): x is { text: string; tone: Tone } => x !== null)
  return (
    <li className={`feed-item ${wrong ? 'wrong' : ''}`}>
      <span className="feed-step">#{int(t.step)}</span>
      <div className="feed-main">
        <span className="feed-amount">Score {score(t.x)}</span>
        <span className={`chip ${t.y_pred ? 'accent' : ''}`}>{folder(t.y_pred)}</span>
        <Status kind={wrong ? 'critical' : 'good'}>{DECISION_TEXT[d]}</Status>
      </div>
      <div className="feed-note feed-subject">“{subjectFor(t.x, t.step)}”</div>
      {feedback && <div className="feed-note">{feedback}.</div>}
      {isWrongDecision(fixed) !== wrong && (
        <div className="feed-note">
          Fixed filter: {folder(t.x >= START_CUTOFF ? 1 : 0).toLowerCase()}, {isWrongDecision(fixed) ? 'wrongly' : 'correctly'}.
        </div>
      )}
      {t.query !== null && t.query_label !== null && (
        <div className="feed-note">
          Reviewer checked an email scoring {score(t.query)}: {t.query_label ? 'spam' : 'not spam'}.
        </div>
      )}
      {notes.map((n, i) => (
        <div className="feed-note" key={i}>
          <StatusIcon kind={TONE_STATUS[n.tone]} className="icon-sm" />
          <span>{n.text}</span>
        </div>
      ))}
    </li>
  )
}
