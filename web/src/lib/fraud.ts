// The fraud story told on the test page, in one place.
//
// The engine is unchanged: input x is a transaction of ₹(10·x), label 1 means
// fraud, and the hidden threshold θ is the amount where fraud starts. An
// analyst check is a label, and fraudsters changing tactics is a drift.

import { int, plural } from './format'
import type { RunEvent, Summary, Tick } from './types'

export const RUPEES_PER_STEP = 10

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })

/** The amount of input x, or the cutoff of threshold θ. */
export const money = (x: number) => inr.format(x * RUPEES_PER_STEP)

/** The input closest to an amount typed in rupees, kept inside 1..n. */
export const inputFor = (rupees: number, n: number) => Math.min(n, Math.max(1, Math.round(rupees / RUPEES_PER_STEP)))

export type Outcome = 'caught' | 'missed' | 'blocked_genuine' | 'approved'

export function outcomeOf(t: Tick): Outcome {
  if (t.y_pred === 1) return t.y_true === 1 ? 'caught' : 'blocked_genuine'
  return t.y_true === 1 ? 'missed' : 'approved'
}

export const OUTCOME_TEXT: Record<Outcome, string> = {
  caught: 'Fraud stopped',
  missed: 'Fraud missed',
  blocked_genuine: 'Genuine customer blocked',
  approved: 'Genuine, approved',
}

export const isWrong = (o: Outcome) => o === 'missed' || o === 'blocked_genuine'

import type { Tone } from './testRun'
export type { Tone }

/** One sentence per engine event, in the fraud story; null for events the page does not show. */
export function fraudEvent(e: RunEvent): { text: string; tone: Tone } | null {
  switch (e.type) {
    case 'injected':
      if (e.to === null) return { text: 'Fraud no longer follows any cutoff: it is now random.', tone: 'warning' }
      if (e.drift === 'gradual')
        return {
          text: `Fraudsters start switching gradually: from ${money(e.from ?? 0)} to ${money(e.to)} over ${plural(e.width ?? 0, 'transaction')}.`,
          tone: 'warning',
        }
      if (e.drift === 'recurring') return { text: `An old fraud pattern is back: fraud starts at ${money(e.to)} again.`, tone: 'warning' }
      return {
        text: `Fraudsters changed tactics: fraud now starts at ${money(e.to)}${e.from !== null ? ` (was ${money(e.from)})` : ''}.`,
        tone: 'warning',
      }
    case 'detected': {
      if (e.false_alarm)
        return { text: "False alarm: an analyst's wrong answer contradicted the engine, so it relearns although nothing changed.", tone: 'critical' }
      if (e.cause === 'out_of_family') return { text: 'No cutoff fits the checked transactions: the engine starts over.', tone: 'warning' }
      if (e.cause === 'gradual') return { text: 'Change detected while the old and new patterns mix.', tone: 'neutral' }
      const after =
        e.delay !== null ? ` It took ${plural(e.delay + 1, 'transaction')} and ${plural(e.mistakes_before_detection ?? 0, 'wrong decision')}.` : ''
      const model = e.reused === undefined ? '' : e.reused ? ' It reuses a model from an earlier pattern.' : ' It starts a fresh model.'
      return { text: `Pattern change detected: a checked transaction contradicted the engine's rule.${after}${model}`, tone: 'neutral' }
    }
    case 'recovered': {
      if (e.theta_hat === null) return null
      const how = e.path === 'memory' ? ' by testing cutoffs it remembered' : ''
      const limit = e.bound !== null ? ` (proven limit ${e.bound})` : ''
      const wrong = e.correct === false ? ' Not the real cutoff: the patterns were still mixing.' : ''
      return {
        text: `${e.initial ? 'Learned' : 'Relearned'}${how}: fraud starts at ${money(e.theta_hat)}. It took ${plural(e.labels, 'analyst check')}${limit}.${wrong}`,
        tone: e.correct === false ? 'warning' : 'good',
      }
    }
    case 'recovery_ended':
      return { text: `Relearning cut short after ${plural(e.labels, 'analyst check')}.`, tone: 'neutral' }
    case 'mode':
      return { text: e.mode === 'robust' ? 'Switched to the noise-tolerant engine.' : 'Switched to the exact engine.', tone: 'neutral' }
    case 'gradual_end':
      return { text: `Fraudsters finished switching: fraud starts at ${money(e.to ?? 0)}.`, tone: 'neutral' }
    default:
      return null
  }
}

/** The page's headline: what is going on right now, and what to try next. */
export function narrate(s: Summary): { title: string; body: string; tone: Tone } {
  const p = `${Math.round(s.p * 100)}%`
  if (!s.in_family)
    return {
      title: 'Fraud has no pattern right now',
      body: 'Fraud is random, so no cutoff explains it. Whatever the engine learns, the next check can contradict it, so it keeps starting over. No engine can learn an arbitrary rule from a few checks: this is one of the proven limits.',
      tone: 'critical',
    }
  if (s.gradual)
    return {
      title: 'Fraudsters are switching tactics gradually',
      body: `For a while, fraud follows the old cutoff (${money(s.gradual.from)}) or the new one (${money(s.gradual.to)}) at random. No single cutoff fits a mix, so the engine may detect the change more than once.`,
      tone: 'warning',
    }
  if (s.mode === 'robust')
    return {
      title: 'Noise-tolerant engine',
      body: `It learns a decision tree from checked transactions and raises an alarm when its error rate rises. Its estimate: fraud starts at about ${money(s.theta_hat ?? 0)}. It copes with wrong analyst answers, but it makes no zero-error promise.`,
      tone: 'neutral',
    }
  const lo = s.lo ?? 1
  const hi = s.hi ?? s.n + 1
  if (s.state !== 'monitoring')
    return {
      title: s.state === 'recalling' ? 'Testing cutoffs it remembers' : 'Learning where fraud starts',
      body: `With each transaction, the engine asks an analyst to check one chosen amount. Each answer rules out half of the possible cutoffs: ${int(hi - lo + 1)} left, between ${money(lo)} and ${money(hi)}. Press "Next transaction" to continue.`,
      tone: 'neutral',
    }
  const truth = s.theta ?? lo
  if (truth !== lo) {
    const from = money(Math.min(truth, lo))
    const to = money(Math.max(truth, lo) - 1)
    if (s.p === 0)
      return {
        title: 'Fraudsters changed tactics, and nobody is checking',
        body: `Every transaction from ${from} to ${to} is now judged wrongly, but spot checks are off, so the engine can never notice. Without checks, a change is invisible: another proven limit.`,
        tone: 'critical',
      }
    return {
      title: "Fraudsters changed tactics. The engine hasn't noticed yet",
      body: `It still believes fraud starts at ${money(lo)}, but now it starts at ${money(truth)}. Every transaction from ${from} to ${to} is judged wrongly. The first one an analyst checks proves the pattern changed: try sending one.`,
      tone: 'warning',
    }
  }
  if (s.noise > 0)
    return {
      title: 'Analysts are making mistakes',
      body: `The engine believes fraud starts at ${money(lo)}. But ${Math.round(s.noise * 100)}% of analyst answers are wrong, and the exact engine treats any contradiction as proof of a change, so it raises false alarms and relearns for nothing. Try the noise-tolerant engine under "Make it harder".`,
      tone: 'warning',
    }
  if (s.p === 0)
    return {
      title: 'Nobody is checking any more',
      body: `The engine knows fraud starts at ${money(lo)}, but spot checks are off. Now change the fraudsters' tactics: without checks, the engine can never notice.`,
      tone: 'warning',
    }
  return {
    title: `The engine knows fraud starts at ${money(lo)}`,
    body: `An analyst spot-checks ${p} of transactions. With correct answers, one contradiction is proof that fraudsters changed tactics, so the engine cannot raise a false alarm. Try "Fraudsters switch to smaller amounts".`,
    tone: 'good',
  }
}
