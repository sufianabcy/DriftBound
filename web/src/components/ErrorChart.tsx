import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { describe } from '../lib/describe'
import { int, pct } from '../lib/format'
import type { Point } from '../lib/useLiveRun'
import type { RunEvent } from '../lib/types'

const MAX_DRAWN = 500 // points per render; more adds nothing at this width
const MAX_MARKS = 40

type Mark = { step: number; kind: 'injected' | 'detected' | 'false_alarm'; event: RunEvent }

function thin(points: Point[]): Point[] {
  if (points.length <= MAX_DRAWN) return points
  const stride = points.length / MAX_DRAWN
  const out: Point[] = []
  for (let i = 0; i < MAX_DRAWN; i++) out.push(points[Math.floor(i * stride)])
  out.push(points[points.length - 1])
  return out
}

const MARK_STROKE = { injected: 'var(--muted)', detected: 'var(--ink-2)', false_alarm: 'var(--critical)' }

/** The glyph at the top of a drift line: shape says what happened, not color alone. */
function MarkGlyph({ kind, viewBox }: { kind: Mark['kind']; viewBox?: { x?: number; y?: number } }) {
  const x = viewBox?.x ?? 0
  const y = (viewBox?.y ?? 0) - 6
  if (kind === 'injected') return <path d={`M${x - 5} ${y - 4}h10l-5 8z`} fill="var(--surface)" stroke="var(--ink-2)" strokeWidth="1.5" />
  return <circle cx={x} cy={y} r="4.5" fill={MARK_STROKE[kind]} stroke="var(--surface)" strokeWidth="2" />
}

export function MarkKey({ kind }: { kind: Mark['kind'] }) {
  return (
    <svg width="12" height="12" aria-hidden="true">
      {kind === 'injected' ? (
        <path d="M1 2h10l-5 8z" fill="var(--surface)" stroke="var(--ink-2)" strokeWidth="1.5" />
      ) : (
        <circle cx="6" cy="6" r="4.5" fill={MARK_STROKE[kind]} />
      )}
    </svg>
  )
}

interface Props {
  points: Point[]
  events: RunEvent[]
  windowSteps: number
  noise: number
  table: boolean
}

export function ErrorChart({ points, events, windowSteps, noise, table }: Props) {
  const lastStep = points.length ? points[points.length - 1].step : 0
  const from = Number.isFinite(windowSteps) ? lastStep - windowSteps : -Infinity
  const shown = useMemo(() => thin(points.filter((p) => p.step > from)), [points, from])
  const differs = shown.some((p) => Math.abs(p.error - p.observed) > 1e-9)
  const marks = useMemo<Mark[]>(() => {
    const found: Mark[] = []
    for (const e of events) {
      if (e.step <= from) continue
      if (e.type === 'injected') found.push({ step: e.step, kind: 'injected', event: e })
      else if (e.type === 'detected') found.push({ step: e.step, kind: e.false_alarm ? 'false_alarm' : 'detected', event: e })
    }
    return found.slice(-MAX_MARKS)
  }, [events, from])

  if (shown.length === 0) return <div className="empty">Waiting for the first steps of the stream.</div>

  if (table) {
    const latest = shown[shown.length - 1]
    return (
      <div className="table-wrap">
        <p className="hint" style={{ marginBottom: 8 }}>
          At step {int(latest.step)}, {pct(latest.error)} of the last 100 answers were wrong, and {pct(latest.observed)} disagreed
          with the labels as observed.
        </p>
        <table>
          <thead>
            <tr>
              <th className="num">Step</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {marks.length === 0 && (
              <tr>
                <td colSpan={2}>No drift in this window.</td>
              </tr>
            )}
            {[...marks].reverse().map((m, i) => (
              <tr key={`${m.step}-${i}`}>
                <td className="num">{int(m.step)}</td>
                <td>{describe(m.event).text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // Start at zero always; stop at the smallest round ceiling that fits, so small spikes stay visible.
  const peak = Math.max(noise, ...shown.map((p) => Math.max(p.error, differs ? p.observed : 0)))
  const yMax = [0.1, 0.25, 0.5, 1].find((c) => peak <= c * 0.92) ?? 1
  const yTicks = [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax]

  const spacing = shown.length > 1 ? (shown[shown.length - 1].step - shown[0].step) / shown.length : 1
  const kinds = new Set(marks.map((m) => m.kind))

  const renderTooltip = ({ active, payload, label }: TooltipContentProps) => {
    if (!active || !payload?.length) return null
    const step = Number(label)
    const near = marks.filter((m) => Math.abs(m.step - step) <= Math.max(1, spacing))
    const row = payload[0].payload as Point
    return (
      <div className="tooltip">
        <div className="tooltip-title">Step {int(step)}</div>
        <div className="tooltip-row">
          <span className="key-line" style={{ background: 'var(--series-1)' }} />
          <strong>{pct(row.error)}</strong> wrong
        </div>
        {differs && (
          <div className="tooltip-row">
            <span className="key-line" style={{ background: 'var(--deemph)' }} />
            <strong>{pct(row.observed)}</strong> disagree with noisy labels
          </div>
        )}
        {near.slice(0, 3).map((m, i) => (
          <div className="tooltip-note" key={i}>
            {describe(m.event).text}
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      <div className="legend">
        <span className="legend-item">
          <span className="key-line" style={{ background: 'var(--series-1)' }} />
          Wrong answers
        </span>
        {differs && (
          <span className="legend-item">
            <span className="key-line" style={{ background: 'var(--deemph)' }} />
            Disagreement with the noisy labels
          </span>
        )}
        {noise > 0 && (
          <span className="legend-item">
            <span className="key-dash" />
            Noise floor {pct(noise, 0)}
          </span>
        )}
        {(['injected', 'detected', 'false_alarm'] as const)
          .filter((k) => kinds.has(k))
          .map((k) => (
            <span className="legend-item" key={k}>
              <MarkKey kind={k} />
              {k === 'injected' ? 'Rule changed' : k === 'detected' ? 'Change detected' : 'False alarm'}
            </span>
          ))}
      </div>
      <div className="chart-box">
        <ResponsiveContainer>
          <LineChart data={shown} margin={{ top: 18, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="step"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={int}
              stroke="var(--axis)"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              domain={[0, yMax]}
              ticks={yTicks}
              tickFormatter={(v: number) => `${Math.round(v * 1000) / 10}%`}
              width={44}
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
            />
            {noise > 0 && <ReferenceLine y={noise} stroke="var(--ink-2)" strokeDasharray="4 4" />}
            {marks.map((m, i) => (
              <ReferenceLine
                key={`${m.kind}-${m.step}-${i}`}
                // False alarms can come in dozens: a short tick at the top, not a wall of lines.
                {...(m.kind === 'false_alarm'
                  ? { segment: [{ x: m.step, y: yMax }, { x: m.step, y: yMax * 0.94 }] }
                  : { x: m.step })}
                stroke={MARK_STROKE[m.kind]}
                strokeWidth={1}
                ifOverflow="discard"
                label={(props: { viewBox?: { x?: number; y?: number } }) => <MarkGlyph kind={m.kind} viewBox={props.viewBox} />}
              />
            ))}
            {differs && (
              <Line
                dataKey="observed"
                stroke="var(--deemph)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            <Line
              dataKey="error"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <Tooltip content={renderTooltip} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}
