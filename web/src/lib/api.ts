// REST calls. Paths are relative, so the same build works behind Vite's dev
// proxy and on the EC2 instance, where FastAPI serves both.

import type {
  DriftKind,
  MetricPoint,
  Mode,
  RunKind,
  RunState,
  ScenarioName,
  StepResult,
  StoredEvent,
  StoredRun,
  Strategy,
} from './types'

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const data = await response.json()
      if (typeof data.detail === 'string') detail = data.detail
      else if (Array.isArray(data.detail)) detail = data.detail.map((d: { msg: string }) => d.msg).join('; ')
    } catch {
      // keep the status line
    }
    throw new ApiError(detail)
  }
  return response.json() as Promise<T>
}

export interface NewRun {
  name?: string
  mode: Mode
  n: number
  p: number
  noise: number
  seed?: number
  theta?: number
  memory: boolean
  speed: number
  start: boolean
  kind?: RunKind
}

export const DEFAULT_RUN: NewRun = { mode: 'exact', n: 1023, p: 1, noise: 0, memory: true, speed: 20, start: true }

export interface SettingsPatch {
  mode?: Mode
  p?: number
  noise?: number
  speed?: number
  memory?: boolean
}

export const api = {
  listRuns: () => call<{ runs: StoredRun[] }>('GET', '/runs?limit=40'),
  createRun: (body: NewRun) => call<RunState>('POST', '/runs', body),
  getRun: (id: string) => call<RunState & { stored?: Record<string, unknown> }>('GET', `/runs/${id}`),
  patchRun: (id: string, body: SettingsPatch) => call<RunState>('PATCH', `/runs/${id}`, body),
  start: (id: string) => call<RunState>('POST', `/runs/${id}/start`),
  stop: (id: string) => call<RunState>('POST', `/runs/${id}/stop`),
  /** Run steps now, playing or paused; with x, the single step processes that input. */
  step: (id: string, count = 1, x?: number) =>
    call<StepResult>('POST', `/runs/${id}/step`, x === undefined ? { count } : { count, x }),
  drift: (id: string, type: DriftKind, theta?: number) =>
    call<{ event: unknown }>('POST', `/runs/${id}/drift`, { type, theta }),
  adversary: (id: string, strategy: Strategy, enabled: boolean, extra: { k?: number } = {}) =>
    call<{ adversary: unknown }>('POST', `/runs/${id}/adversary`, { strategy, enabled, ...extra }),
  scenario: (id: string, name: ScenarioName) => call<{ event: unknown }>('POST', `/runs/${id}/scenario`, { name }),
  events: (id: string) => call<{ events: StoredEvent[] }>('GET', `/runs/${id}/events`),
  metrics: (id: string) => call<{ metrics: MetricPoint[] }>('GET', `/runs/${id}/metrics?max_points=1500`),
}

export function liveSocketUrl(runId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/runs/${runId}/live`
}
