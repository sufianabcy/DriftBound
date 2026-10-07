import { DRIFT_LABEL, int, PATH_LABEL, plural } from './format'
import type { RunEvent, StoredEvent, Summary } from './types'

const STRATEGY_LABEL: Record<string, string> = {
  worst_case: 'Worst-case answers',
  rapid_fire: 'Rapid fire',
  stealth: 'Stealth drift',
  noise: 'Label noise',
}

const SCENARIO_LABEL: Record<string, string> = {
  monitoring_off: 'monitoring off',
  noisy_labels: 'noisy labels',
  out_of_family: 'rule outside the family',
  rapid_fire: 'rapid fire',
  all_clear: 'all clear',
}

const rule = (theta: number | null | undefined) => (theta === null || theta === undefined ? 'random labels' : `θ = ${int(theta)}`)

export type EventTone = 'drift' | 'detect' | 'alarm' | 'recover' | 'info'

/** One plain sentence per event, for the event log and tooltips. */
export function describe(e: RunEvent): { text: string; tone: EventTone } {
  switch (e.type) {
    case 'injected':
      return {
        text: `Rule changed (${DRIFT_LABEL[e.drift] ?? e.drift}): ${rule(e.from)} → ${rule(e.to)}${e.width ? ` over ${plural(e.width, 'step')}` : ''}`,
        tone: 'drift',
      }
    case 'detected': {
      if (e.false_alarm) return { text: 'False alarm: a flipped label contradicted the rule', tone: 'alarm' }
      const what =
        e.cause === 'out_of_family'
          ? 'No threshold fits the labels'
          : e.cause === 'gradual'
            ? 'Detected while two rules mix'
            : 'Change detected'
      const after =
        e.delay !== null
          ? ` after ${plural(e.delay + 1, 'step')} and ${plural(e.mistakes_before_detection ?? 0, 'wrong answer')}`
          : ''
      const reuse = e.reused === undefined ? '' : e.reused ? '; reused a stored model' : '; started a fresh model'
      return { text: `${what}${after}${reuse}`, tone: 'detect' }
    }
    case 'recovered':
      return {
        text: e.initial
          ? `Learned the rule in ${plural(e.labels, 'label')} (limit ${e.bound})`
          : `Relearned in ${plural(e.labels, 'label')} (limit ${e.bound}) by ${PATH_LABEL[e.path].toLowerCase()}${e.correct === false ? ', wrong rule' : ''}`,
        tone: 'recover',
      }
    case 'recovery_ended':
      return { text: `Relearning ${PATH_LABEL[e.path].toLowerCase()} after ${plural(e.labels, 'label')}`, tone: 'info' }
    case 'mode':
      return { text: `Switched to ${e.mode} mode`, tone: 'info' }
    case 'adversary':
      return { text: `${STRATEGY_LABEL[e.strategy ?? ''] ?? e.strategy} ${e.enabled ? 'on' : 'off'}`, tone: 'info' }
    case 'scenario':
      return { text: `Lab scenario: ${SCENARIO_LABEL[e.name ?? ''] ?? e.name}`, tone: 'info' }
    case 'gradual_end':
      return { text: `Gradual change finished at ${rule(e.to)}`, tone: 'info' }
  }
}

/** Stored drift_events rows, reshaped into live events so the same charts can replay them. */
export function fromStored(rows: StoredEvent[]): RunEvent[] {
  const out: RunEvent[] = []
  for (const r of rows) {
    const d = r.details as Record<string, never>
    if (r.source === 'injected') {
      out.push({ type: 'injected', step: r.step, drift: r.drift_type, from: d.from ?? null, to: d.to ?? null, width: d.width })
      continue
    }
    out.push({
      type: 'detected',
      step: r.step,
      drift: r.drift_type,
      cause: d.cause ?? 'drift',
      false_alarm: Boolean(d.false_alarm),
      delay: d.delay ?? null,
      mistakes_before_detection: d.mistakes_before_detection ?? null,
      mode: d.mode ?? 'exact',
      reused: d.reused,
    })
    if (r.labels_to_recover !== null) {
      out.push({
        type: 'recovered',
        step: d.recovered_at ?? r.step,
        labels: r.labels_to_recover,
        bound: r.bound,
        path: d.path ?? 'full',
        initial: false,
        correct: d.correct ?? null,
        recall_k: 0,
        theta_hat: d.theta_hat ?? null,
        overlap: false,
      })
    }
  }
  return out
}

export interface ConditionRow {
  key: keyof Summary['conditions']
  name: string
  achievable: string
  impossible: string
  now: string
  ok: boolean
}

/** The boundary table from docs/theory.md, with the live state of each condition. */
export function conditionRows(s: Summary): ConditionRow[] {
  const a = s.adversary
  const timing = a.rapid_fire
    ? `Rule changes every ${a.rapid_fire} step${a.rapid_fire > 1 ? 's' : ''}`
    : a.stealth
      ? 'Stealth drift creeps faster than labels can catch it'
      : s.gradual
        ? 'Gradual drift is mixing two rules'
        : !s.conditions.drift_timing
          ? 'A drift landed in the middle of a recovery'
          : 'Drifts arrive one at a time'
  return [
    {
      key: 'rule_family',
      name: 'Rule family',
      achievable: 'The true rule always comes from a known finite set',
      impossible: 'Any rule at all is allowed',
      now: s.in_family ? `A threshold, one of ${int(s.n + 1)} rules` : 'Random labels: no threshold fits',
      ok: s.conditions.rule_family,
    },
    {
      key: 'labels_clean',
      name: 'Labels',
      achievable: 'Labels are correct',
      impossible: 'Labels are noisy',
      now: s.noise > 0 ? `${Math.round(s.noise * 100)}% of labels are flipped` : 'Every label is correct',
      ok: s.conditions.labels_clean,
    },
    {
      key: 'label_access',
      name: 'Label access',
      achievable: 'The engine can request labels after a drift',
      impossible: 'No labels arrive after a drift',
      now: s.p > 0 ? `Labels on ${Math.round(s.p * 100)}% of points while monitoring` : 'Monitoring is off (p = 0)',
      ok: s.conditions.label_access,
    },
    {
      key: 'drift_timing',
      name: 'Drift timing',
      achievable: 'Drifts are at least one adaptation period apart',
      impossible: 'The rule may change at every step',
      now: timing,
      ok: s.conditions.drift_timing,
    },
  ]
}
