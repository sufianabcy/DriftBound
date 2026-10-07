import { useMemo, useState } from 'react'
import { fromStored } from '../lib/describe'
import { int } from '../lib/format'
import type { MetricPoint, Recovery, StoredEvent, StoredRun } from '../lib/types'
import { ErrorChart } from './ErrorChart'
import { LabelsChart } from './LabelsChart'
import { EventLog } from './Panels'
import { Card, TableToggle } from './ui'

export interface ReplayData {
  run: StoredRun
  metrics: MetricPoint[]
  events: StoredEvent[]
}

/** A finished run, rebuilt from the database: proof the history really is stored. */
export function Replay({ data, onClose }: { data: ReplayData; onClose: () => void }) {
  const [tables, setTables] = useState({ error: false, labels: false })
  const events = useMemo(() => fromStored(data.events), [data.events])
  const points = useMemo(
    () => data.metrics.map((m) => ({ step: m.step, error: m.error_rate, observed: m.observed_error_rate })),
    [data.metrics],
  )
  const recoveries = useMemo(
    () => events.filter((e): e is Recovery & { type: 'recovered' } => e.type === 'recovered'),
    [events],
  )
  const n = Number((data.run as unknown as { config?: { n?: number } }).config?.n ?? 1023)
  const bound = Math.ceil(Math.log2(n + 1))
  const last = data.metrics[data.metrics.length - 1]

  return (
    <div className="stack">
      <div className="replay-bar">
        <div>
          <strong>Replay: {data.run.name}</strong>
          <div className="hint">
            {data.run.mode} mode · {last ? `${int(last.step)} steps` : 'no metric points stored'} ·{' '}
            {last ? `${int(last.false_alarms)} false alarms, ${int(last.labels_total)} labels` : ''} · loaded from the database
          </div>
        </div>
        <button type="button" className="btn" onClick={onClose}>
          Back to the live run
        </button>
      </div>
      <Card
        id="replay-error"
        title="Error over time"
        subtitle="Stored metric points, thinned on the server."
        actions={<TableToggle table={tables.error} onChange={(t) => setTables({ ...tables, error: t })} />}
      >
        <ErrorChart points={points} events={events} windowSteps={Infinity} noise={0} table={tables.error} />
      </Card>
      <Card
        id="replay-labels"
        title="Labels per drift"
        subtitle="From the drift_events table: labels_to_recover against the stored bound."
        actions={<TableToggle table={tables.labels} onChange={(t) => setTables({ ...tables, labels: t })} />}
      >
        <LabelsChart recoveries={recoveries} fromStep={-Infinity} recoveryBound={bound} n={n} table={tables.labels} />
      </Card>
      <EventLog events={events} />
    </div>
  )
}
