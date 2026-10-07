import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { SettingsPatch } from '../lib/api'
import { int, rate } from '../lib/format'
import type { DriftKind, Mode, RunInfo, ScenarioName, Strategy, Summary } from '../lib/types'
import { PauseIcon, PlayIcon } from './ui'

const SPEEDS = [1, 5, 10, 20, 50, 100, 200, 500]
const TABS = [
  { id: 'try', label: 'Try it' },
  { id: 'break', label: 'Break it' },
  { id: 'settings', label: 'Settings' },
] as const
type Tab = (typeof TABS)[number]['id']

/** A slider that keeps its own value while dragging and sends it once the hand rests. */
function useDebouncedSetting(value: number, send: (v: number) => void) {
  const [local, setLocal] = useState(value)
  const [seen, setSeen] = useState(value)
  const timer = useRef<number | undefined>(undefined)
  if (value !== seen) {
    // The server confirmed a new value (ours or another viewer's): show it.
    setSeen(value)
    setLocal(value)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const change = (v: number) => {
    setLocal(v)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => send(v), 180)
  }
  return [local, change] as const
}

function ActionRow({
  title,
  children,
  label,
  onClick,
  disabled,
  pressed,
}: {
  title: string
  children: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
}) {
  return (
    <li className="action-row">
      <h3>{title}</h3>
      <button
        type="button"
        className="btn btn-small"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={pressed === undefined ? undefined : pressed}
      >
        {pressed === undefined ? label : pressed ? 'Turn off' : label}
      </button>
      <p>{children}</p>
    </li>
  )
}

interface Props {
  summary: Summary
  run: RunInfo
  busy: boolean
  onDrift: (kind: DriftKind) => void
  onAdversary: (strategy: Strategy, enabled: boolean, k?: number) => void
  onScenario: (name: ScenarioName) => void
  onPatch: (patch: SettingsPatch) => void
  onStartStop: () => void
  onNewRun: () => void
  className?: string
}

/** Every way to act on the run, in three tabs: experiments, broken assumptions, settings. */
export function ControlPanel(props: Props) {
  const { summary: s, run, busy, onStartStop, onPatch, className } = props
  const [tab, setTab] = useState<Tab>('try')
  const running = run.status === 'running'

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = TABS.findIndex((t) => t.id === tab)
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id
    setTab(next)
    document.getElementById(`tab-${next}`)?.focus()
  }

  return (
    <section className={className ? `card ${className}` : 'card'} aria-labelledby="controls-title">
      <div className="card-head">
        <div>
          <h2 id="controls-title">Control panel</h2>
          <p className="card-sub">Change the hidden rule, break an assumption, or tune the run.</p>
        </div>
      </div>

      <div className="run-bar">
        <button type="button" className="btn btn-primary" onClick={onStartStop} disabled={busy}>
          {running ? <PauseIcon /> : <PlayIcon />}
          {running ? 'Pause' : 'Play'}
        </button>
        <select
          value={run.speed ?? 20}
          onChange={(e) => onPatch({ speed: Number(e.target.value) })}
          aria-label="Steps per second"
        >
          {[...new Set([...SPEEDS, run.speed ?? 20])]
            .sort((a, b) => a - b)
            .map((v) => (
              <option key={v} value={v}>
                {v} {v === 1 ? 'step' : 'steps'}/s
              </option>
            ))}
        </select>
      </div>

      <div className="tabs" role="tablist" aria-label="Controls" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="panel-try" aria-labelledby="tab-try" hidden={tab !== 'try'}>
        <TryIt {...props} />
      </div>
      <div role="tabpanel" id="panel-break" aria-labelledby="tab-break" hidden={tab !== 'break'}>
        <BreakIt {...props} />
      </div>
      <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== 'settings'}>
        <Settings {...props} />
      </div>

      <p className="hint panel-foot">Step {int(s.step)}</p>
    </section>
  )
}

function TryIt({ summary: s, busy, onDrift, onAdversary }: Props) {
  return (
    <>
      <p className="panel-intro">Each button changes the hidden rule. Watch the number line and the two charts.</p>
      <ul className="action-list">
        <ActionRow title="Change the rule" label="Change it" onClick={() => onDrift('abrupt')} disabled={busy}>
          The hidden threshold jumps. The engine catches it at the first checked mistake, then relearns in about{' '}
          {s.bounds.recovery_labels} labels.
        </ActionRow>
        <ActionRow title="Bring back an old rule" label="Bring back" onClick={() => onDrift('recurring')} disabled={busy}>
          A rule seen before returns. With memory on, the engine finds it in 2 to 5 labels instead of {s.bounds.recovery_labels}.
        </ActionRow>
        <ActionRow title="Change it gradually" label="Start" onClick={() => onDrift('gradual')} disabled={busy || !s.in_family}>
          For 200 steps, answers come from the old or the new rule at random. No single rule fits a mix, so expect several
          detections.
        </ActionRow>
        <ActionRow
          title="Worst-case attacker"
          label="Turn on"
          pressed={s.adversary.worst_case}
          onClick={() => onAdversary('worst_case', !s.adversary.worst_case)}
          disabled={busy || s.mode !== 'exact'}
        >
          Every 100 steps it picks the new rule that is hardest to find. No recovery can take fewer than{' '}
          {s.bounds.recovery_labels} labels: the lower bound, live.
        </ActionRow>
      </ul>
      <p className="hint panel-foot">Tip: click anywhere on the number line to move the hidden rule yourself.</p>
    </>
  )
}

function BreakIt({ summary: s, busy, onScenario, onAdversary }: Props) {
  return (
    <>
      <p className="panel-intro">
        Each scenario breaks one of the four conditions behind the guarantee. The banner turns red and names it.
      </p>
      <ul className="action-list">
        <ActionRow title="No labels after a change" label="Run" onClick={() => onScenario('monitoring_off')} disabled={busy}>
          Checking stops, then the rule changes. Wrong answers pile up, and the change is never detected.
        </ActionRow>
        <ActionRow title="Wrong labels (10%)" label="Run" onClick={() => onScenario('noisy_labels')} disabled={busy}>
          One label in ten is wrong. False alarms appear with no change at all. Then try Robust mode in Settings.
        </ActionRow>
        <ActionRow title="No rule to find" label="Run" onClick={() => onScenario('out_of_family')} disabled={busy}>
          The answers become random. No threshold fits, so the engine keeps starting over and gets about half wrong.
        </ActionRow>
        <ActionRow title="Rule changes every step" label="Run" onClick={() => onScenario('rapid_fire')} disabled={busy}>
          The rule flips against every prediction, so every answer is wrong.
        </ActionRow>
        <ActionRow
          title="Slow creep"
          label="Turn on"
          pressed={s.adversary.stealth}
          onClick={() => onAdversary('stealth', !s.adversary.stealth)}
          disabled={busy}
        >
          The rule moves by one every {s.adversary.stealth_period} steps. Tiny changes need many labels to notice.
        </ActionRow>
      </ul>
      <button type="button" className="btn btn-primary btn-wide panel-foot" onClick={() => onScenario('all_clear')} disabled={busy}>
        Restore everything
      </button>
    </>
  )
}

function Settings({ summary: s, busy, onPatch, onNewRun }: Props) {
  const [p, setP] = useDebouncedSetting(s.p, (v) => onPatch({ p: v }))
  const [noise, setNoise] = useDebouncedSetting(s.noise, (v) => onPatch({ noise: v }))
  const setMode = (mode: Mode) => mode !== s.mode && onPatch({ mode })
  return (
    <>
      <div className="section-label">Engine</div>
      <div className="segmented" role="group" aria-label="Engine mode">
        <button type="button" aria-pressed={s.mode === 'exact'} onClick={() => setMode('exact')} disabled={busy}>
          Exact
        </button>
        <button type="button" aria-pressed={s.mode === 'robust'} onClick={() => setMode('robust')} disabled={busy}>
          Robust
        </button>
      </div>
      <p className="hint" style={{ margin: '6px 0 16px' }}>
        {s.mode === 'exact'
          ? 'Keeps every rule that fits the labels. Proven zero error under the four conditions.'
          : 'A decision tree plus a change detector. Copes with wrong labels, but promises nothing exact.'}
      </p>

      <div className="field">
        <div className="field-row">
          <label htmlFor="p">Labels while monitoring</label>
          <output htmlFor="p" className="num">
            {rate(p)}
          </output>
        </div>
        <input id="p" type="range" min={0} max={1} step={0.05} value={p} onChange={(e) => setP(Number(e.target.value))} />
        <span className="hint">
          {p > 0
            ? `The share of inputs the engine checks once it knows the rule. About ${int(Math.round(1 / p))} wrong answer${p === 1 ? '' : 's'} slip by before a change is caught.`
            : 'No labels once the rule is known: a change goes unseen.'}
        </span>
      </div>

      <div className="field">
        <div className="field-row">
          <label htmlFor="noise">Wrong labels</label>
          <output htmlFor="noise" className="num">
            {rate(noise)}
          </output>
        </div>
        <input id="noise" type="range" min={0} max={0.3} step={0.01} value={noise} onChange={(e) => setNoise(Number(e.target.value))} />
        <span className="hint">Each label is flipped with this probability.</span>
      </div>

      {s.mode === 'exact' && (
        <label className="switch field">
          <span>
            Memory recall
            <span className="hint" style={{ display: 'block', fontWeight: 400 }}>
              Try remembered rules first: {s.bounds.recall_labels ?? '–'} labels if one returns.
            </span>
          </span>
          <input type="checkbox" checked={s.recall} onChange={(e) => onPatch({ memory: e.target.checked })} />
        </label>
      )}

      <button type="button" className="btn btn-wide" onClick={onNewRun}>
        New run…
      </button>
      <p className="hint" style={{ marginTop: 8 }}>
        This run: N = {int(s.n)}, seed {s.config.seed}.
      </p>
    </>
  )
}
