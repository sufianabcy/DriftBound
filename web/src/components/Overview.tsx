import { conditionRows } from '../lib/describe'
import { compact, int, pct, plural } from '../lib/format'
import type { Summary } from '../lib/types'
import { StatusIcon } from './ui'

/** The one-line verdict: does the zero-error theorem apply right now, and if not, why not. */
export function GuaranteeBanner({ summary: s }: { summary: Summary }) {
  if (s.mode === 'robust') {
    return (
      <div className="banner" role="status">
        <StatusIcon kind="neutral" />
        <div>
          <strong>Robust mode: probabilistic guarantees only</strong>
          <p>
            A decision tree learns from the labels, and a change detector (ADWIN) raises an alarm once the error rate rises by more
            than chance allows. It copes with noisy labels, but it makes no zero-error promise.
          </p>
        </div>
      </div>
    )
  }
  if (s.guarantee) {
    return (
      <div className="banner ok" role="status">
        <StatusIcon kind="good" />
        <div>
          <strong>Zero-error guarantee in force: all four conditions hold</strong>
          <p>
            No false alarms. A change is caught at the first checked mistake. Relearning takes at most {s.bounds.recovery_labels}{' '}
            labels, and every answer after that is correct.
          </p>
        </div>
      </div>
    )
  }
  const broken = conditionRows(s).filter((r) => !r.ok)
  return (
    <div className="banner bad" role="status">
      <StatusIcon kind="critical" />
      <div>
        <strong>Zero-error guarantee suspended: {broken.map((r) => r.name.toLowerCase()).join(', ')}</strong>
        <p>{broken.map((r) => r.now).join('. ')}. The proven limits say no engine can promise zero error here.</p>
      </div>
    </div>
  )
}

export function StatTiles({ summary: s }: { summary: Summary }) {
  const c = s.counters
  const exactClean = s.mode === 'exact' && s.noise === 0
  return (
    <div className="tiles">
      <div className="tile tile-hero">
        <span className="tile-label">False alarms</span>
        <span className="tile-value">{int(c.false_alarms)}</span>
        <span className="tile-note">
          {c.false_alarms === 0 ? (
            <>
              <StatusIcon kind="good" className="icon-sm" />
              {exactClean ? 'Proven to stay 0 on clean labels' : 'None so far'}
            </>
          ) : (
            <>
              <StatusIcon kind="critical" className="icon-sm" />
              Caused by wrong labels
            </>
          )}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Wrong answers</span>
        <span className="tile-value">{compact(c.mistakes)}</span>
        <span className="tile-note">{pct(s.error_rate)} of the last 100</span>
      </div>
      <div className="tile">
        <span className="tile-label">Labels used</span>
        <span className="tile-value">{compact(c.labels)}</span>
        <span className="tile-note">Correct answers the engine paid to see</span>
      </div>
      <div className="tile">
        <span className="tile-label">Detections</span>
        <span className="tile-value">
          {int(c.detections)}
          <small> for {plural(c.injected, 'rule change')}</small>
        </span>
        <span className="tile-note">
          {s.last_delay !== null ? `Last one caught after ${plural(s.last_delay + 1, 'step')}` : 'No change caught yet'}
        </span>
      </div>
    </div>
  )
}
