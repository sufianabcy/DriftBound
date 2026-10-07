import type { ReactNode } from 'react'

export function Card({
  id,
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  id: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={className ? `card ${className}` : 'card'} aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {subtitle ? <p className="card-sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Every chart has a table twin; this flips between them. */
export function TableToggle({ table, onChange }: { table: boolean; onChange: (table: boolean) => void }) {
  return (
    <button type="button" className="btn btn-small" aria-pressed={table} onClick={() => onChange(!table)}>
      Table view
    </button>
  )
}

export type StatusKind = 'good' | 'critical' | 'warning' | 'neutral'

const STATUS_FILL: Record<StatusKind, string> = {
  good: 'var(--good)',
  critical: 'var(--critical)',
  warning: 'var(--warning)',
  neutral: 'var(--muted)',
}

/** A status color never travels alone: callers always put a text label beside it. */
export function StatusIcon({ kind, className = 'status-icon' }: { kind: StatusKind; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill={STATUS_FILL[kind]} />
      {kind === 'good' && (
        <path
          d="M5.6 10.4l3 3 5.8-6.4"
          stroke="#fff"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {kind === 'critical' && <path d="M6.6 6.6l6.8 6.8M13.4 6.6l-6.8 6.8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />}
      {kind === 'warning' && <path d="M10 5.4v5.8M10 14.3v.3" stroke="#2b241c" strokeWidth="2.2" strokeLinecap="round" />}
      {kind === 'neutral' && <path d="M6 10h8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  )
}

export function Status({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  return (
    <span className="status-cell">
      <StatusIcon kind={kind} className="icon-sm" />
      {children}
    </span>
  )
}

export function BrandMark() {
  return (
    <svg viewBox="0 0 28 28" className="brand-mark" aria-hidden="true">
      <rect width="28" height="28" rx="7" fill="var(--accent)" />
      <path
        d="M5 19h8V9h10"
        stroke="var(--accent-ink)"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="13" cy="14" r="2.6" fill="var(--accent-ink)" />
    </svg>
  )
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
    </svg>
  )
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="2.8" width="3.2" height="10.4" rx="1" fill="currentColor" />
      <rect x="9.3" y="2.8" width="3.2" height="10.4" rx="1" fill="currentColor" />
    </svg>
  )
}

export function ArrowIcon({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" style={back ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M3 8h9.5M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The live connection, in one pill: is this page receiving the run right now? */
export function ConnectionPill({
  connection,
  status,
  viewers,
}: {
  connection: string
  status?: string
  viewers?: number
}) {
  const live = connection === 'open'
  const label = live
    ? status === 'running'
      ? 'Live'
      : 'Paused'
    : connection === 'gone'
      ? 'Not live'
      : connection === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting'
  return (
    <span className="pill" title="Connection to the engine">
      <span className={`dot ${live && status === 'running' ? 'on' : live ? '' : connection === 'gone' ? '' : 'warn'}`} />
      {label}
      {live && viewers && viewers > 1 ? ` · ${viewers} watching` : ''}
    </span>
  )
}
