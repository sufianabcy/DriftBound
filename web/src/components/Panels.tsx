import { conditionRows, describe } from '../lib/describe'
import type { EventTone } from '../lib/describe'
import { int, plural, timeAgo } from '../lib/format'
import type { RunEvent, StoredRun, Summary } from '../lib/types'
import { Card, Status, StatusIcon } from './ui'

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** The boundary from docs/theory.md, with the live state of each condition. */
export function Conditions({ summary, className }: { summary: Summary; className?: string }) {
  const rows = conditionRows(summary)
  return (
    <Card
      id="boundary"
      className={className}
      title="When is zero error possible?"
      subtitle="Four conditions, each proven necessary. Break one from the control panel and see what fails."
    >
      <ul className="conditions">
        {rows.map((r) => (
          <li key={r.key} className={`condition ${r.ok ? 'ok' : 'bad'}`}>
            <div className="condition-head">
              <h3>{r.name}</h3>
              <span className={`chip ${r.ok ? 'good' : 'bad'}`}>
                <StatusIcon kind={r.ok ? 'good' : 'critical'} className="icon-sm" />
                {r.ok ? 'Holds' : 'Broken'}
              </span>
            </div>
            <p className="condition-now">{r.now}</p>
            <p className="condition-rule">
              Zero error is possible when {lower(r.achievable)}, and impossible when {lower(r.impossible)}.
            </p>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const TONE_ICON: Record<EventTone, 'good' | 'critical' | 'warning' | 'neutral'> = {
  drift: 'warning',
  detect: 'neutral',
  alarm: 'critical',
  recover: 'good',
  info: 'neutral',
}

export function EventLog({ events, className }: { events: RunEvent[]; className?: string }) {
  const recent = events.slice(-60).reverse()
  return (
    <Card id="events" className={className} title="What just happened" subtitle="Every change, detection and recovery, newest first.">
      {recent.length === 0 ? (
        <div className="empty" style={{ minHeight: 80 }}>
          Nothing has happened yet.
        </div>
      ) : (
        <ul className="events">
          {recent.map((e, i) => {
            const d = describe(e)
            return (
              <li key={`${e.step}-${e.type}-${i}`}>
                <span className="step">{int(e.step)}</span>
                <StatusIcon kind={TONE_ICON[d.tone]} className="icon-sm" />
                <span>{d.text}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

export function RunHistory({
  runs,
  currentId,
  replayId,
  onOpen,
  onRefresh,
}: {
  runs: StoredRun[]
  currentId: string | null
  replayId: string | null
  onOpen: (run: StoredRun) => void
  onRefresh: () => void
}) {
  return (
    <details className="history">
      <summary>
        Run history
        <span className="hint">
          {runs.length ? `${plural(runs.length, 'run')}, stored in the database` : 'stored in the database'}
        </span>
      </summary>
      <div className="history-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <p className="hint">Watch a run that is still live, or replay a finished one from its stored rows.</p>
          <button type="button" className="btn btn-small" onClick={onRefresh}>
            Refresh
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="empty" style={{ minHeight: 80 }}>
            No runs stored yet.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th className="num">Steps</th>
                  <th className="num">Changes / detections</th>
                  <th className="num">False alarms</th>
                  <th className="num">Labels</th>
                  <th>Created</th>
                  <th>
                    <span className="visually-hidden">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className={`clickable ${r.id === currentId || r.id === replayId ? 'current' : ''}`}
                    onClick={() => onOpen(r)}
                  >
                    <td>
                      {r.name}
                      {(r.kind === 'fraud' || r.kind === 'spam') && (
                        <>
                          {' '}
                          <span className="chip accent">{r.kind === 'fraud' ? 'Fraud test' : 'Spam test'}</span>
                        </>
                      )}
                    </td>
                    <td>{r.mode}</td>
                    <td>
                      <Status kind={r.status === 'running' ? 'good' : r.status === 'error' ? 'critical' : 'neutral'}>
                        {r.live ? `${r.status}, live` : r.status}
                      </Status>
                    </td>
                    <td className="num">{r.steps === null ? '–' : int(r.steps)}</td>
                    <td className="num">
                      {r.injected ?? 0} / {r.detected ?? 0}
                    </td>
                    <td className="num">{r.false_alarms ?? 0}</td>
                    <td className="num">{r.labels === null ? '–' : int(r.labels)}</td>
                    <td>{timeAgo(r.created_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpen(r)
                        }}
                      >
                        {r.kind !== undefined && r.kind !== 'dashboard' && r.live ? 'Open' : r.live ? 'Watch' : 'Replay'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  )
}
