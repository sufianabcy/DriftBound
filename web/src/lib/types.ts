// Shapes sent by the API. They mirror engine/runner.py and api/routes.py.

export type Mode = 'exact' | 'robust'
export type EngineState = 'learning' | 'recalling' | 'monitoring'
export type RecoveryPath = 'full' | 'memory' | 'memory_fallback' | 'interrupted' | 'abandoned' | 'open_at_close'
export type DetectionCause = 'drift' | 'gradual' | 'out_of_family' | 'noise'
export type ScenarioName = 'monitoring_off' | 'noisy_labels' | 'out_of_family' | 'rapid_fire' | 'all_clear'
export type DriftKind = 'abrupt' | 'gradual' | 'recurring' | 'out_of_family'
export type Strategy = 'worst_case' | 'rapid_fire' | 'stealth' | 'noise'
// 'fraud' and 'spam' runs belong to the two test pages; the dashboard never joins them.
export type RunKind = 'dashboard' | 'fraud' | 'spam'

export interface InjectedEvent {
  type: 'injected'
  step: number
  drift: string
  from: number | null
  to: number | null
  width?: number
}

export interface DetectedEvent {
  type: 'detected'
  step: number
  drift: string | null
  cause: DetectionCause
  false_alarm: boolean
  delay: number | null
  mistakes_before_detection: number | null
  mode: Mode
  reused?: boolean
}

export interface Recovery {
  step: number
  labels: number
  bound: number | null
  path: RecoveryPath
  initial: boolean
  correct: boolean | null
  recall_k: number
  theta_hat: number | null
  overlap: boolean
}

export type RecoveredEvent = Recovery & { type: 'recovered' | 'recovery_ended' }

export interface OtherEvent {
  type: 'mode' | 'adversary' | 'scenario' | 'gradual_end'
  step: number
  mode?: Mode
  strategy?: Strategy
  enabled?: boolean
  name?: ScenarioName
  to?: number
}

export type RunEvent = InjectedEvent | DetectedEvent | RecoveredEvent | OtherEvent

export interface Tick {
  step: number
  x: number
  y_true: number
  y_obs: number
  y_pred: number
  labeled: boolean
  query: number | null
  query_label: number | null
  state: EngineState
  mode: Mode
  lo: number | null
  hi: number | null
  theta: number | null
  theta_hat: number | null
  error_rate: number
  observed_error_rate: number
  mistakes_total: number
  labels_total: number
  candidates_left: number | null
  false_alarms: number
  events: RunEvent[]
}

export interface Conditions {
  rule_family: boolean
  labels_clean: boolean
  label_access: boolean
  drift_timing: boolean
}

export interface Summary {
  step: number
  mode: Mode
  state: EngineState
  n: number
  p: number
  noise: number
  theta: number | null
  in_family: boolean
  gradual: { from: number; to: number; weight_new: number } | null
  lo: number | null
  hi: number | null
  theta_hat: number | null
  candidates_left: number | null
  memory: number[]
  recall: boolean
  error_rate: number
  observed_error_rate: number
  counters: {
    mistakes: number
    labels: number
    false_alarms: number
    detections: number
    injected: number
    recoveries: number
    memory_size: number
    // Decisions against the true rule; a positive is label 1 (fraud, on the test page).
    confusion: { tp: number; fp: number; tn: number; fn: number }
  }
  adversary: {
    worst_case: boolean
    worst_case_gap: number
    rapid_fire: number | null
    rapid_changes: number
    stealth: boolean
    stealth_period: number
  }
  scheduled_drift: string | null
  last_delay: number | null
  bounds: {
    recovery_labels: number
    recall_labels: number | null
    recall_fallback_labels: number | null
    mistakes_per_drift_p1: number
    expected_mistakes_before_detection: number | null
    noise_floor: number
  }
  recovery_stats: { count: number; max_labels: number | null; within_bound: boolean }
  conditions: Conditions
  guarantee: boolean
  config: { n: number; seed: number; memory: boolean; memory_capacity: number; metric_every: number }
}

export interface RunInfo {
  id: string
  name: string
  status: 'created' | 'running' | 'stopped' | 'interrupted' | 'error'
  stop_reason?: string | null
  speed?: number
  created_at: string
  viewers?: number
  live: boolean
  kind?: RunKind
}

export interface RunState {
  run: RunInfo
  summary: Summary
}

export interface StepResult extends RunState {
  ticks: Tick[]
}

export interface HistoryPoint {
  step: number
  error_rate: number
  observed_error_rate: number
  labels_total: number
}

export interface StoredRun extends RunInfo {
  mode: Mode
  steps: number | null
  injected: number | null
  detected: number | null
  false_alarms: number | null
  labels: number | null
}

export interface StoredEvent {
  id: number
  step: number
  source: 'injected' | 'detected'
  drift_type: string
  labels_to_recover: number | null
  bound: number | null
  details: Record<string, unknown>
}

export interface MetricPoint {
  step: number
  mode: Mode
  error_rate: number
  observed_error_rate: number
  mistakes_total: number
  labels_total: number
  candidates_left: number | null
  false_alarms: number
}

export type ServerMessage =
  | {
      type: 'snapshot'
      run: RunInfo
      summary: Summary
      history: HistoryPoint[]
      events: RunEvent[]
      recoveries: Recovery[]
      ticks?: Tick[]
    }
  | { type: 'ticks'; ticks: Tick[]; run: RunInfo; summary: Summary }
  | { type: 'state'; run: RunInfo; summary: Summary }
  | { type: 'ping' }
  | { type: 'closed'; reason: string }
  | { type: 'error'; detail: string }
