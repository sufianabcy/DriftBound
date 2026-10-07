// The spam story told on /spam/, in one place.
//
// The engine is unchanged. A separate filter gives every email a spam score
// from 1 to n; input x is that score. The engine does not score emails: it
// keeps the cutoff right. Emails scoring at or above the cutoff go to the spam
// folder (prediction 1), the rest to the inbox. The hidden threshold θ is the
// score where real spam starts. While learning, a human reviewer checks an
// email at the score the engine asks about; while monitoring, the labels are
// users' reports. Spammers changing their wording is a drift.

import { int, plural } from './format'
import { decide } from './testRun'
import type { Decision, Tone } from './testRun'
import type { RunEvent, Summary, Tick } from './types'

/** The cutoff a filter tuned on day one would keep forever: the baseline. */
export const START_CUTOFF = 600

export const score = (x: number) => int(x)

export const DECISION_TEXT: Record<Decision, string> = {
  tp: 'Spam caught',
  fn: 'Spam in the inbox',
  fp: 'Real mail in spam',
  tn: 'Delivered',
}

export const folder = (prediction: number) => (prediction ? 'Spam folder' : 'Inbox')

/** Where a filter that never adapts would have put this email, and whether that was right. */
export const fixedDecision = (t: Tick, cutoff = START_CUTOFF): Decision => decide(t.x >= cutoff ? 1 : 0, t.y_true)

// Simulated subject lines. They suit the score, not the truth: the truth depends
// on where the hidden cutoff is right now, which is the whole point.
const SUBJECTS: [number, string[]][] = [
  [
    250,
    [
      'Minutes from Tuesday’s team meeting',
      'Can we move our call to 4 pm?',
      'Photos from the weekend',
      'Your library books are due Friday',
      'Lunch on Thursday?',
      'Updated project timeline',
    ],
  ],
  [
    450,
    [
      'Your monthly account statement',
      'Reminder: subscription renews next week',
      'Your order has shipped',
      'Webinar recording now available',
      'New sign-in to your account',
      'Feedback on your recent purchase',
    ],
  ],
  [
    650,
    [
      'Members-only offer ends tonight',
      'You have unclaimed reward points',
      'Last chance: 40% off everything',
      'Quick question about your account',
      'Re: your invoice (action needed)',
      'Exclusive deal picked just for you',
    ],
  ],
  [
    850,
    [
      'Your parcel is on hold: pay the fee',
      'Verify your password within 24 hours',
      'Work from home and earn ₹50,000 a week',
      'Congratulations, you were selected',
      'Final notice: your account will close',
      'Cheap loans, approved instantly',
    ],
  ],
  [
    Infinity,
    [
      'YOU WON ₹1,00,00,000!!! CLAIM NOW',
      'Urgent: wire the transfer fee today',
      'FREE iPhone, just click here',
      'Hot singles near you',
      'Double your crypto in 24 hours',
      'Lottery winner: send your bank details',
    ],
  ],
]

export function subjectFor(x: number, step: number): string {
  const list = SUBJECTS.find(([upTo]) => x < upTo)![1]
  return list[(x * 7 + step * 13) % list.length]
}

/** What the user did with this email, if anything, in plain words. */
export function feedbackOf(t: Tick): string | null {
  if (!t.labeled) return null
  const wrongly = t.y_obs !== t.y_true ? ' (by mistake)' : ''
  if (t.y_obs !== t.y_pred) return t.y_obs ? `A user clicked “Report spam”${wrongly}` : `A user clicked “Not spam”${wrongly}`
  return `A user opened it and left it where it was${wrongly}`
}

/** One sentence per engine event, in the spam story; null for events the page does not show. */
export function spamEvent(e: RunEvent): { text: string; tone: Tone } | null {
  switch (e.type) {
    case 'injected':
      if (e.to === null) return { text: 'Spam no longer follows the scores: it is now random.', tone: 'warning' }
      if (e.drift === 'gradual')
        return {
          text: `Spammers start rewording gradually: real spam moves from score ${score(e.from ?? 0)} to ${score(e.to)} over ${plural(e.width ?? 0, 'email')}.`,
          tone: 'warning',
        }
      if (e.drift === 'recurring') return { text: `An old campaign is back: spam starts at score ${score(e.to)} again.`, tone: 'warning' }
      return {
        text: `Spammers changed their wording: spam now starts at score ${score(e.to)}${e.from !== null ? ` (was ${score(e.from)})` : ''}.`,
        tone: 'warning',
      }
    case 'detected': {
      if (e.false_alarm)
        return { text: 'False alarm: a mistaken report contradicted the cutoff, so the engine relearns although nothing changed.', tone: 'critical' }
      if (e.cause === 'out_of_family') return { text: 'No cutoff fits the reports: the engine starts over.', tone: 'warning' }
      if (e.cause === 'gradual') return { text: 'Change detected while old and new wording mix.', tone: 'neutral' }
      const after =
        e.delay !== null ? ` It took ${plural(e.delay + 1, 'email')} and ${plural(e.mistakes_before_detection ?? 0, 'misfiled email')}.` : ''
      const model = e.reused === undefined ? '' : e.reused ? ' It reuses a model from an earlier campaign.' : ' It starts a fresh model.'
      return { text: `Wording change detected: a report contradicted the cutoff.${after}${model}`, tone: 'neutral' }
    }
    case 'recovered': {
      if (e.theta_hat === null) return null
      const how = e.path === 'memory' ? ' by retrying cutoffs from earlier campaigns' : ''
      const limit = e.bound !== null ? ` (proven limit ${e.bound})` : ''
      const wrong = e.correct === false ? ' Not the real cutoff: old and new wording were still mixing.' : ''
      return {
        text: `${e.initial ? 'Set' : 'Reset'} the cutoff${how}: spam starts at score ${score(e.theta_hat)}. It took ${plural(e.labels, 'review')}${limit}.${wrong}`,
        tone: e.correct === false ? 'warning' : 'good',
      }
    }
    case 'recovery_ended':
      return { text: `Relearning cut short after ${plural(e.labels, 'review')}.`, tone: 'neutral' }
    case 'mode':
      return { text: e.mode === 'robust' ? 'Switched to the noise-tolerant engine.' : 'Switched to the exact engine.', tone: 'neutral' }
    case 'gradual_end':
      return { text: `Spammers finished rewording: spam starts at score ${score(e.to ?? 0)}.`, tone: 'neutral' }
    default:
      return null
  }
}

/** The page's headline: what is going on right now, and what to try next. */
export function narrateSpam(s: Summary): { title: string; body: string; tone: Tone } {
  const p = `${Math.round(s.p * 100)}%`
  if (!s.in_family)
    return {
      title: 'Spam has no score pattern right now',
      body: 'Which emails are spam no longer depends on the score, so no cutoff can sort them. Whatever cutoff the engine picks, the next report can contradict it, so it keeps starting over. No engine can learn an arbitrary rule from a few reports: this is one of the proven limits.',
      tone: 'critical',
    }
  if (s.gradual)
    return {
      title: 'Spammers are rewording gradually',
      body: `For a while, spam follows the old cutoff (score ${score(s.gradual.from)}) or the new one (score ${score(s.gradual.to)}) at random. No single cutoff fits a mix, so the engine may detect the change more than once.`,
      tone: 'warning',
    }
  if (s.mode === 'robust')
    return {
      title: 'Noise-tolerant engine',
      body: `It learns from reports with a decision tree, and raises an alarm when its error rate rises. Its estimate: spam starts at about score ${score(s.theta_hat ?? 0)}. It copes with mistaken reports and imperfect scores, but it makes no zero-error promise.`,
      tone: 'neutral',
    }
  const lo = s.lo ?? 1
  const hi = s.hi ?? s.n + 1
  if (s.state !== 'monitoring')
    return {
      title: s.state === 'recalling' ? 'Retrying cutoffs from earlier campaigns' : 'Finding the right cutoff',
      body: `With each email, a reviewer checks one email from today’s mail whose score the engine picks. Each answer rules out half of the possible cutoffs: ${int(hi - lo + 1)} left, between score ${score(lo)} and ${score(hi)}. Press "Next email" to continue.`,
      tone: 'neutral',
    }
  const truth = s.theta ?? lo
  if (truth !== lo) {
    const from = score(Math.min(truth, lo))
    const to = score(Math.max(truth, lo) - 1)
    const where = truth < lo ? 'spam is landing in the inbox' : 'real mail is landing in the spam folder'
    if (s.p === 0)
      return {
        title: 'Spammers changed their wording, and nobody reports',
        body: `Emails scoring ${from} to ${to} are misfiled: ${where}. But nobody is reporting, so the engine can never notice. Without reports, a change is invisible: another proven limit.`,
        tone: 'critical',
      }
    return {
      title: "Spammers changed their wording. The engine hasn't noticed yet",
      body: `Its cutoff is still score ${score(lo)}, but spam now starts at score ${score(truth)}. Emails scoring ${from} to ${to} are misfiled: ${where}. The first one a user reports proves the wording changed. Users report ${p} of emails; try sending one with a score in that range.`,
      tone: 'warning',
    }
  }
  if (s.noise > 0)
    return {
      title: 'Users are mis-reporting',
      body: `The cutoff is score ${score(lo)}. But ${Math.round(s.noise * 100)}% of reports are wrong, and the exact engine treats any contradiction as proof of a change, so it raises false alarms and relearns for nothing. Try the noise-tolerant engine under "Make it harder".`,
      tone: 'warning',
    }
  if (s.p === 0)
    return {
      title: 'Nobody reports any more',
      body: `The cutoff is right, at score ${score(lo)}, but no user reports anything. Now make spammers change their wording: without reports, the engine can never notice.`,
      tone: 'warning',
    }
  return {
    title: `The cutoff is right: spam starts at score ${score(lo)}`,
    body: `Users report ${p} of emails. With honest reports, one that contradicts the cutoff is proof that spammers changed their wording, so the engine cannot raise a false alarm. Try "Spam slips in with lower scores", and watch the fixed filter fall behind.`,
    tone: 'good',
  }
}
