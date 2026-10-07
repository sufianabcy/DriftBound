import { useMemo } from 'react'
import { Bar, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import type { BarShapeProps, TooltipContentProps } from 'recharts'
import { int, PATH_LABEL } from '../lib/format'
import type { Recovery, RecoveryPath } from '../lib/types'
import { Status } from './ui'

const MAX_BARS = 30

// Categorical slots in fixed order; anything unfinished drops to the de-emphasis gray.
const PATH_COLOR: Record<RecoveryPath, string> = {
  full: 'var(--series-1)',
  memory: 'var(--series-2)',
  memory_fallback: 'var(--series-3)',
  interrupted: 'var(--deemph)',
  abandoned: 'var(--deemph)',
  open_at_close: 'var(--deemph)',
}

interface Row extends Recovery {
  name: string
  boundTick?: number
}

function BarWithRoundTop(props: BarShapeProps) {
  const { x, y, width, height } = props
  const row = props.payload as Row
  if (!height || height <= 0) return <g />
  const r = Math.min(4, width / 2, height)
  const d = `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
  return <path d={d} fill={PATH_COLOR[row.path]} />
}

function BoundTick(props: { cx?: number; cy?: number }) {
  const { cx, cy } = props
  if (cx === undefined || cy === undefined || Number.isNaN(cy)) return <g />
  return <line x1={cx - 13} x2={cx + 13} y1={cy} y2={cy} stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
}

interface Props {
  recoveries: Recovery[]
  fromStep: number
  recoveryBound: number
  n: number
  table: boolean
}

export function LabelsChart({ recoveries, fromStep, recoveryBound, n, table }: Props) {
  const rows = useMemo<Row[]>(() => {
    let drift = 0
    const named = recoveries.map((r) => ({
      ...r,
      name: r.initial ? 'start' : `#${++drift}`,
      boundTick: r.bound ?? undefined,
    }))
    return named.filter((r) => r.step > fromStep).slice(-MAX_BARS)
  }, [recoveries, fromStep])

  if (rows.length === 0) return <div className="empty">No relearning in this window yet. Change the rule to see one.</div>

  if (table) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Change</th>
              <th className="num">Step</th>
              <th>How it recovered</th>
              <th className="num">Labels</th>
              <th className="num">Limit</th>
              <th>Within limit</th>
              <th>Rule found</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={`${r.step}-${r.name}`}>
                <td>{r.name}</td>
                <td className="num">{int(r.step)}</td>
                <td>{PATH_LABEL[r.path]}</td>
                <td className="num">{r.labels}</td>
                <td className="num">{r.bound ?? '–'}</td>
                <td>
                  {r.bound === null ? '–' : r.labels <= r.bound ? <Status kind="good">Yes</Status> : <Status kind="critical">No</Status>}
                </td>
                <td>{r.correct === null ? '–' : r.correct ? 'True rule' : 'Wrong rule (assumptions broken)'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const yMax = Math.max(recoveryBound + 2, ...rows.map((r) => r.labels + 1), ...rows.map((r) => (r.bound ?? 0) + 1))
  const present = new Set(rows.map((r) => r.path))
  const legendPaths = (Object.keys(PATH_COLOR) as RecoveryPath[]).filter(
    (p) => present.has(p) && (p === 'full' || p === 'memory' || p === 'memory_fallback'),
  )
  const unfinished = rows.some((r) => r.bound === null)

  const renderTooltip = ({ active, payload }: TooltipContentProps) => {
    if (!active || !payload?.length) return null
    const r = payload[0].payload as Row
    return (
      <div className="tooltip">
        <div className="tooltip-title">
          {r.initial ? 'First learning' : `Recovery ${r.name}`} · step {int(r.step)}
        </div>
        <div className="tooltip-row">
          <strong>{r.labels}</strong> labels{r.bound !== null ? `, proven limit ${r.bound}` : ''}
        </div>
        <div className="tooltip-note">{PATH_LABEL[r.path]}</div>
        {r.correct === false && <div className="tooltip-note">Found the wrong rule: an assumption was broken.</div>}
      </div>
    )
  }

  return (
    <>
      <div className="legend">
        {legendPaths.map((p) => (
          <span className="legend-item" key={p}>
            <span className="key-rect" style={{ background: PATH_COLOR[p] }} />
            {PATH_LABEL[p]}
          </span>
        ))}
        {unfinished && (
          <span className="legend-item">
            <span className="key-rect" style={{ background: 'var(--deemph)' }} />
            Cut short
          </span>
        )}
        <span className="legend-item">
          <span className="key-line" style={{ background: 'var(--ink)' }} />
          Proven limit for that bar
        </span>
        <span className="legend-item">
          <span className="key-dash" />
          Plain search: ⌈log₂ {int(n + 1)}⌉ = {recoveryBound} labels
        </span>
      </div>
      <div className="chart-box short">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 14, right: 14, bottom: 0, left: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="name"
              stroke="var(--axis)"
              tickLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              interval="preserveStartEnd"
              minTickGap={8}
            />
            <YAxis
              domain={[0, yMax]}
              allowDecimals={false}
              width={32}
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
            />
            <ReferenceLine y={recoveryBound} stroke="var(--ink-2)" strokeDasharray="4 4" />
            <Bar dataKey="labels" maxBarSize={24} shape={BarWithRoundTop} isAnimationActive={false} />
            <Scatter dataKey="boundTick" shape={BoundTick} isAnimationActive={false} legendType="none" />
            <Tooltip content={renderTooltip} cursor={{ fill: 'var(--surface-2)' }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}
