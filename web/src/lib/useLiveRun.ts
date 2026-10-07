import { useCallback, useEffect, useReducer } from 'react'
import { liveSocketUrl } from './api'
import type { Recovery, RunEvent, RunInfo, RunState, ServerMessage, StepResult, Summary, Tick } from './types'

const MAX_POINTS = 6000 // the widest chart window, in steps
const MAX_EVENTS = 400
const MAX_RECOVERIES = 80
const MAX_TICKS = 50 // full ticks kept for the fraud page's transaction feed

export interface Point {
  step: number
  error: number // rolling error against the true rule
  observed: number // rolling error against the labels as observed (noisy)
}

export type Connection = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'gone'

export interface LiveState {
  connection: Connection
  notice: string | null
  run: RunInfo | null
  summary: Summary | null
  points: Point[]
  events: RunEvent[]
  recoveries: Recovery[]
  ticks: Tick[] // the latest full ticks, oldest first
  seen: number // the highest step already folded in; older ticks are duplicates
  lastQuery: { step: number; x: number; label: number } | null
}

const initial: LiveState = {
  connection: 'idle',
  notice: null,
  run: null,
  summary: null,
  points: [],
  events: [],
  recoveries: [],
  ticks: [],
  seen: 0,
  lastQuery: null,
}

type Action =
  | { type: 'reset' }
  | { type: 'connection'; connection: Connection }
  | { type: 'message'; message: ServerMessage }
  | { type: 'state'; state: RunState }
  | { type: 'stepped'; result: StepResult }

const isRecovery = (e: RunEvent): e is RunEvent & Recovery => e.type === 'recovered' || e.type === 'recovery_ended'
const toPoint = (t: Tick): Point => ({ step: t.step, error: t.error_rate, observed: t.observed_error_rate })
const keep = <T,>(list: T[], max: number) => (list.length > max ? list.slice(-max) : list)

function lastQueryOf(ticks: Tick[], fallback: LiveState['lastQuery']): LiveState['lastQuery'] {
  let found = fallback
  for (const t of ticks) {
    if (t.query !== null && t.query_label !== null) found = { step: t.step, x: t.query, label: t.query_label }
  }
  return found
}

/**
 * Fold new ticks in. A step taken by hand arrives twice, in the REST reply and
 * on the WebSocket, in either order; ticks at or below `seen` are skipped.
 */
function fold(state: LiveState, ticks: Tick[], run: RunInfo, summary: Summary): LiveState {
  const fresh = ticks.filter((t) => t.step > state.seen)
  if (fresh.length === 0) return { ...state, run, summary }
  const newEvents = fresh.flatMap((t) => t.events)
  const ended = newEvents.filter(isRecovery)
  return {
    ...state,
    run,
    summary,
    points: keep(state.points.concat(fresh.map(toPoint)), MAX_POINTS),
    events: newEvents.length ? keep(state.events.concat(newEvents), MAX_EVENTS) : state.events,
    recoveries: ended.length ? keep(state.recoveries.concat(ended), MAX_RECOVERIES) : state.recoveries,
    ticks: keep(state.ticks.concat(fresh), MAX_TICKS),
    seen: fresh[fresh.length - 1].step,
    lastQuery: lastQueryOf(fresh, state.lastQuery),
  }
}

function reducer(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case 'reset':
      return initial
    case 'connection':
      return { ...state, connection: action.connection }
    case 'state':
      return { ...state, run: action.state.run, summary: action.state.summary }
    case 'stepped':
      return fold(state, action.result.ticks, action.result.run, action.result.summary)
    case 'message':
      return onMessage(state, action.message)
  }
}

function onMessage(state: LiveState, m: ServerMessage): LiveState {
  switch (m.type) {
    case 'snapshot': {
      const ticks = m.ticks ?? []
      return {
        ...initial,
        connection: 'open',
        run: m.run,
        summary: m.summary,
        points: m.history.map((h) => ({ step: h.step, error: h.error_rate, observed: h.observed_error_rate })),
        events: m.events.slice(-MAX_EVENTS),
        recoveries: m.recoveries.slice(-MAX_RECOVERIES),
        ticks: ticks.slice(-MAX_TICKS),
        seen: m.summary.step,
        lastQuery: lastQueryOf(ticks, null),
      }
    }
    case 'ticks':
      return fold(state, m.ticks, m.run, m.summary)
    case 'state':
      return { ...state, run: m.run, summary: m.summary }
    case 'closed':
      return { ...state, connection: 'gone', notice: `This run was closed: ${m.reason}.` }
    case 'error':
      return { ...state, connection: 'gone', notice: m.detail }
    case 'ping':
      return state
  }
}

/** Live state of one run, kept current over a WebSocket that reconnects on its own. */
export function useLiveRun(runId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial)

  useEffect(() => {
    dispatch({ type: 'reset' })
    if (!runId) return
    let socket: WebSocket | null = null
    let finished = false
    let attempt = 0
    let timer: number | undefined

    const connect = () => {
      dispatch({ type: 'connection', connection: attempt === 0 ? 'connecting' : 'reconnecting' })
      socket = new WebSocket(liveSocketUrl(runId))
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage
        if (message.type === 'snapshot') attempt = 0
        if (message.type === 'closed' || message.type === 'error') finished = true
        dispatch({ type: 'message', message })
      }
      socket.onclose = () => {
        if (finished) return
        attempt += 1
        dispatch({ type: 'connection', connection: 'reconnecting' })
        timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt))
      }
    }

    connect()
    return () => {
      finished = true
      window.clearTimeout(timer)
      socket?.close()
    }
  }, [runId])

  // REST commands answer with fresh state; show it before the next tick arrives.
  const apply = useCallback((next: RunState) => dispatch({ type: 'state', state: next }), [])
  const applyStep = useCallback((result: StepResult) => dispatch({ type: 'stepped', result }), [])
  return { ...state, apply, applyStep }
}
