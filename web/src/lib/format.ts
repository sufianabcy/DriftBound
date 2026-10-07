const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const int = (n: number) => integer.format(n)

/** 1,284 / 12.9K / 4.2M: compact only once a number gets long. */
export const compact = (n: number) => (Math.abs(n) < 10_000 ? integer.format(n) : compactFmt.format(n))

/** "1 step", "4 steps". */
export const plural = (n: number, word: string) => `${int(n)} ${word}${n === 1 ? '' : 's'}`

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`

/** 0.1 -> "10%", 0.25 -> "25%": for settings, where trailing zeros are noise. */
export const rate = (x: number) => `${Math.round(x * 1000) / 10}%`

export function timeAgo(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export const PATH_LABEL: Record<string, string> = {
  full: 'Binary search',
  memory: 'Memory recall',
  memory_fallback: 'Recall missed, then search',
  interrupted: 'Interrupted',
  abandoned: 'Abandoned (mode switch)',
  open_at_close: 'Unfinished',
}

export const STATE_LABEL: Record<string, string> = {
  learning: 'Learning',
  recalling: 'Recalling',
  monitoring: 'Monitoring',
}

export const DRIFT_LABEL: Record<string, string> = {
  abrupt: 'abrupt',
  gradual: 'gradual',
  recurring: 'recurring',
  worst_case: 'worst-case',
  rapid_fire: 'rapid fire',
  stealth: 'stealth',
  out_of_family: 'out of family',
  noise: 'noise',
  drift: 'drift',
}
