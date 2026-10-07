import { useCallback, useEffect, useRef, useState } from 'react'
import { api, DEFAULT_RUN } from './lib/api'
import type { NewRun, SettingsPatch } from './lib/api'
import { int } from './lib/format'
import type { DriftKind, RunState, ScenarioName, StoredRun, Strategy, Summary } from './lib/types'
import { useLiveRun } from './lib/useLiveRun'
import { ControlPanel } from './components/ControlPanel'
import { ErrorChart } from './components/ErrorChart'
import { Explainer } from './components/Explainer'
import { LabelsChart } from './components/LabelsChart'
import { NewRunDialog } from './components/NewRunDialog'
import { NumberLine } from './components/NumberLine'
import { GuaranteeBanner, StatTiles } from './components/Overview'
import { Conditions, EventLog, RunHistory } from './components/Panels'
import { Replay } from './components/Replay'
import type { ReplayData } from './components/Replay'
import { ArrowIcon, BrandMark, Card, ConnectionPill, TableToggle } from './components/ui'

const WINDOWS = [
  { steps: 500, label: '500' },
  { steps: 2000, label: '2,000' },
  { steps: 6000, label: '6,000' },
]

const runFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('run')

function StateChip({ summary: s }: { summary: Summary }) {
  if (s.mode === 'robust')
    return <span className="chip accent">{s.state === 'monitoring' ? 'Watching for changes' : 'Warming up'}</span>
  if (s.state === 'monitoring') return <span className="chip good">Monitoring</span>
  if (s.state === 'recalling') return <span className="chip accent">Checking memory</span>
  return (
    <span className="chip accent">
      Learning{s.candidates_left !== null ? ` · ${int(s.candidates_left)} left` : ''}
    </span>
  )
}

export default function App() {
  const [runId, setRunId] = useState<string | null>(runFromHash)
  const live = useLiveRun(runId)
  const { apply } = live
  const [replay, setReplay] = useState<ReplayData | null>(null)
  const [windowSteps, setWindowSteps] = useState(2000)
  const [tables, setTables] = useState({ error: false, labels: false })
  const [history, setHistory] = useState<StoredRun[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const refreshHistory = useCallback(() => {
    api
      .listRuns()
      .then((r) => setHistory(r.runs))
      .catch(() => undefined)
  }, [])

  // First visit: join the newest live dashboard run, so every viewer sees the same one, or start one.
  useEffect(() => {
    if (runId) return
    let cancelled = false
    api
      .listRuns()
      .then(async ({ runs }) => {
        const existing = runs.find((r) => r.live && r.kind !== 'fraud')
        const id = existing ? existing.id : (await api.createRun(DEFAULT_RUN)).run.id
        if (!cancelled) setRunId(id)
      })
      .catch((e: Error) => setToast(`Cannot reach the API: ${e.message}`))
    return () => {
      cancelled = true
    }
  }, [runId])

  useEffect(() => {
    if (runId) window.history.replaceState(null, '', `#run=${runId}`)
  }, [runId])

  useEffect(() => {
    const onHash = () => setRunId(runFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    refreshHistory()
    const timer = window.setInterval(refreshHistory, 15_000)
    return () => window.clearInterval(timer)
  }, [refreshHistory])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  /** Run a command; show its fresh state at once, or its error as a toast. */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      try {
        const result = await fn()
        if (result && typeof result === 'object' && 'summary' in result) apply(result as RunState)
      } catch (e) {
        setToast((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apply],
  )

  const createRun = (body: NewRun) =>
    act(async () => {
      const state = await api.createRun(body)
      setReplay(null)
      setRunId(state.run.id)
      refreshHistory()
      return state
    })

  const openRun = (run: StoredRun) => {
    if (run.kind === 'fraud' && run.live) {
      window.location.href = `/test/#run=${run.id}`
      return
    }
    if (run.live) {
      setReplay(null)
      setRunId(run.id)
      return
    }
    void act(async () => {
      const [metrics, events] = await Promise.all([api.metrics(run.id), api.events(run.id)])
      setReplay({ run, metrics: metrics.metrics, events: events.events })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }

  const s = live.summary
  const run = live.run
  const id = run?.id ?? runId
  const patch = (body: SettingsPatch) => id && act(() => api.patchRun(id, body))
  const drift = (kind: DriftKind, theta?: number) => id && act(() => api.drift(id, kind, theta))
  const adversary = (strategy: Strategy, enabled: boolean, k?: number) =>
    id && act(() => api.adversary(id, strategy, enabled, k ? { k } : {}))
  const scenario = (name: ScenarioName) => id && act(() => api.scenario(id, name))
  const startStop = () => id && run && act(() => (run.status === 'running' ? api.stop(id) : api.start(id)))

  const lastStep = live.points.length ? live.points[live.points.length - 1].step : 0
  const query = s && s.mode === 'exact' && live.lastQuery && s.step - live.lastQuery.step <= 30 ? live.lastQuery : null
  const marker = query
    ? {
        value: query.x,
        label: `Last label: is ${int(query.x)} at or above θ? The answer was ${query.label ? 'yes (1)' : 'no (0)'}.`,
      }
    : null

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <BrandMark />
          <div style={{ minWidth: 0 }}>
            <h1>DriftBound</h1>
            <div className="brand-sub">{replay ? 'Viewing a stored run' : 'Concept drift detection with proven limits'}</div>
          </div>
        </a>
        <div className="topbar-actions">
          <ConnectionPill connection={live.connection} status={run?.status} viewers={run?.viewers} />
          <a className="btn btn-primary" href="/test/">
            Test fraud detection
            <ArrowIcon />
          </a>
        </div>
      </header>

      {live.connection === 'gone' && !replay && (
        <div className="replay-bar" role="alert">
          <span>{live.notice ?? 'This run is no longer live.'} The server keeps runs in memory, so a restart ends them.</span>
          <button type="button" className="btn btn-primary" onClick={() => createRun(DEFAULT_RUN)}>
            Start a new run
          </button>
        </div>
      )}

      {replay ? (
        <Replay data={replay} onClose={() => setReplay(null)} />
      ) : s && run ? (
        <>
          <Explainer />
          <GuaranteeBanner summary={s} />
          <StatTiles summary={s} />
          <div className="layout">
            <div className="stack">
              <Card
                id="numberline"
                className="order-1"
                title={s.mode === 'exact' ? 'The hidden rule, and what the engine knows' : "The hidden rule, and the model's estimate"}
                subtitle={`The line holds every possible threshold, from 1 to ${int(s.n + 1)}. The engine cannot see the triangle; it has to work it out from labels.`}
                actions={<StateChip summary={s} />}
              >
                <NumberLine summary={s} marker={marker} onPick={(theta) => drift('abrupt', theta)} />
              </Card>

              <Card
                id="error"
                className="order-3"
                title="Wrong answers over time"
                subtitle="The share of wrong answers in the last 100 steps. A triangle marks a rule change, a dot its detection: the gap is the detection delay."
                actions={
                  <>
                    <div className="segmented compact" role="group" aria-label="Steps shown in both charts">
                      {WINDOWS.map((w) => (
                        <button key={w.steps} type="button" aria-pressed={windowSteps === w.steps} onClick={() => setWindowSteps(w.steps)}>
                          {w.label}
                        </button>
                      ))}
                    </div>
                    <TableToggle table={tables.error} onChange={(t) => setTables({ ...tables, error: t })} />
                  </>
                }
              >
                <ErrorChart points={live.points} events={live.events} windowSteps={windowSteps} noise={s.noise} table={tables.error} />
              </Card>

              <Card
                id="labels"
                className="order-4"
                title="Labels needed to relearn"
                subtitle="One bar per relearning. Its black tick is the proven limit for that bar, and no bar ever crosses it."
                actions={<TableToggle table={tables.labels} onChange={(t) => setTables({ ...tables, labels: t })} />}
              >
                <LabelsChart
                  recoveries={live.recoveries}
                  fromStep={lastStep - windowSteps}
                  recoveryBound={s.bounds.recovery_labels}
                  n={s.n}
                  table={tables.labels}
                />
              </Card>

              <Conditions summary={s} className="order-5" />
            </div>

            <div className="stack">
              <ControlPanel
                className="order-2"
                summary={s}
                run={run}
                busy={busy}
                onDrift={(k) => drift(k)}
                onAdversary={adversary}
                onScenario={scenario}
                onPatch={patch}
                onStartStop={startStop}
                onNewRun={() => dialogRef.current?.showModal()}
              />
              <EventLog className="order-6" events={live.events} />
            </div>
          </div>
        </>
      ) : (
        <div className="card empty">Connecting to the engine…</div>
      )}

      <RunHistory runs={history} currentId={replay ? null : id} replayId={replay?.run.id ?? null} onOpen={openRun} onRefresh={refreshHistory} />

      <NewRunDialog dialogRef={dialogRef} onCreate={createRun} />

      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
