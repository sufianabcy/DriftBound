// What the two test pages (fraud at /test/, spam at /spam/) share: one run per
// visitor, kept in the address bar, and the commands a reviewer can send it.

import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { NewRun, SettingsPatch } from './api'
import type { DriftKind, RunState, StepResult, Tick } from './types'
import { useLiveRun } from './useLiveRun'

export type Tone = 'good' | 'warning' | 'critical' | 'neutral'

/** A decision against the true rule. Positive means label 1: fraud, or spam. */
export type Decision = 'tp' | 'fp' | 'tn' | 'fn'

export const decide = (predicted: number, actual: number): Decision =>
  predicted ? (actual ? 'tp' : 'fp') : actual ? 'fn' : 'tn'

export const decisionOf = (t: Tick): Decision => decide(t.y_pred, t.y_true)

export const isWrongDecision = (d: Decision) => d === 'fp' || d === 'fn'

export const TEST_SPEEDS = [1, 2, 5, 20] // inputs per second when playing

export const randomBetween = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))

const runFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('run')

// React mounts effects twice in development; share one request so only one run is created.
const pending = new Map<string, Promise<RunState>>()
function createOnce(defaults: NewRun): Promise<RunState> {
  const key = defaults.kind ?? 'dashboard'
  let request = pending.get(key)
  if (!request) {
    request = api.createRun(defaults)
    pending.set(key, request)
    request.finally(() => window.setTimeout(() => pending.delete(key), 0)).catch(() => undefined)
  }
  return request
}

/**
 * One live run for this visitor, created with `defaults` unless the address
 * already names one. Every command shows its fresh state at once, or its error
 * as a toast (after passing through `friendly`).
 */
export function useTestRun(defaults: NewRun, friendly: (message: string) => string = (m) => m) {
  const [runId, setRunId] = useState<string | null>(runFromHash)
  const live = useLiveRun(runId)
  const { apply, applyStep } = live
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (runId) return
    let cancelled = false
    createOnce(defaults)
      .then((state) => {
        if (!cancelled) setRunId(state.run.id)
      })
      .catch((e: Error) => setToast(`Cannot reach the API: ${e.message}`))
    return () => {
      cancelled = true
    }
  }, [runId, defaults])

  useEffect(() => {
    if (runId) window.history.replaceState(null, '', `#run=${runId}`)
  }, [runId])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      try {
        const out = await fn()
        if (out && typeof out === 'object' && 'ticks' in out) applyStep(out as StepResult)
        else if (out && typeof out === 'object' && 'summary' in out) apply(out as RunState)
        return out
      } catch (e) {
        setToast(friendly((e as Error).message))
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [apply, applyStep, friendly],
  )

  const run = live.run
  const id = run?.id ?? runId

  const commands = {
    /** One step that processes input x; resolves to its tick. */
    send: async (x: number): Promise<Tick | null> => {
      if (!id) return null
      const out = (await act(() => api.step(id, 1, x))) as StepResult | undefined
      return out?.ticks[0] ?? null
    },
    next: (count: number) => id && act(() => api.step(id, count)),
    drift: (kind: DriftKind, theta?: number) => id && act(() => api.drift(id, kind, theta)),
    patch: (body: SettingsPatch) => id && act(() => api.patchRun(id, body)),
    playPause: (speed: number) =>
      id &&
      run &&
      act(async () => {
        if (run.status === 'running') return api.stop(id)
        await api.patchRun(id, { speed })
        return api.start(id)
      }),
    startOver: () =>
      act(async () => {
        const state = await createOnce(defaults)
        setRunId(state.run.id)
        return state
      }),
  }

  return { live, summary: live.summary, run, busy, toast, setToast, ...commands }
}
