import { useState } from 'react'
import type { ReactNode } from 'react'
import { TEST_SPEEDS } from '../lib/testRun'
import type { Tone } from '../lib/testRun'
import { ArrowIcon, BrandMark, ConnectionPill, PauseIcon, PlayIcon } from './ui'

const TONE_CLASS: Record<Tone, string> = { good: 'ok', warning: 'warn', critical: 'bad', neutral: '' }

/** The top bar of a test page: what this page is, the connection, and the way to the other pages. */
export function TestHeader({
  subtitle,
  connection,
  status,
  links,
}: {
  subtitle: string
  connection: string
  status?: string
  links: { href: string; label: string; primary?: boolean }[]
}) {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <BrandMark />
        <div style={{ minWidth: 0 }}>
          <h1>DriftBound</h1>
          <div className="brand-sub">{subtitle}</div>
        </div>
      </a>
      <div className="topbar-actions">
        <ConnectionPill connection={connection} status={status} />
        {links.map((l) => (
          <a key={l.href} className={l.primary ? 'btn btn-primary' : 'btn'} href={l.href}>
            {l.href === '/' && <ArrowIcon back />}
            {l.label}
            {l.href !== '/' && <ArrowIcon />}
          </a>
        ))}
      </div>
    </header>
  )
}

export function NowCard({ title, body, tone }: { title: string; body: string; tone: Tone }) {
  return (
    <div className={`now ${TONE_CLASS[tone]}`} role="status" aria-live="polite">
      <span className="now-label">What is happening now</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  )
}

export function EndedBar({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div className="replay-bar" role="alert">
      <span>This test has ended: the server restarted or the test sat idle for too long.</span>
      <button type="button" className="btn btn-primary" onClick={onStartOver}>
        Start a new test
      </button>
    </div>
  )
}

export function Toast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}

export function Toggle({
  title,
  on,
  onChange,
  busy,
  children,
}: {
  title: string
  on: boolean
  onChange: (on: boolean) => void
  busy: boolean
  children: ReactNode
}) {
  return (
    <li className="action-row">
      <h3>{title}</h3>
      <button type="button" className="btn btn-small" aria-pressed={on} disabled={busy} onClick={() => onChange(!on)}>
        {on ? 'Turn off' : 'Turn on'}
      </button>
      <p>{children}</p>
    </li>
  )
}

/** Next, Next 10, and Play at a chosen pace: the ways to let inputs arrive on their own. */
export function StepControls({
  noun,
  busy,
  running,
  speed,
  onNext,
  onPlayPause,
  onSpeed,
}: {
  noun: { one: string; many: string }
  busy: boolean
  running: boolean
  speed: number
  onNext: (count: number) => void
  onPlayPause: (speed: number) => void
  onSpeed: (speed: number) => void
}) {
  const [pace, setPace] = useState(TEST_SPEEDS.includes(speed) ? speed : 2)
  return (
    <>
      <div className="section-label" style={{ marginTop: 18 }}>
        Or let {noun.many} arrive
      </div>
      <div className="step-buttons">
        <button type="button" className="btn" disabled={busy} onClick={() => onNext(1)}>
          Next {noun.one}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => onNext(10)}>
          Next 10
        </button>
      </div>
      <div className="play-row">
        <button type="button" className="btn" disabled={busy} onClick={() => onPlayPause(pace)}>
          {running ? <PauseIcon /> : <PlayIcon />}
          {running ? 'Pause' : 'Play'}
        </button>
        <select
          aria-label={`${noun.many} per second`}
          value={pace}
          onChange={(e) => {
            const v = Number(e.target.value)
            setPace(v)
            onSpeed(v)
          }}
        >
          {TEST_SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v} per second
            </option>
          ))}
        </select>
      </div>
    </>
  )
}
