import { useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { money } from '../lib/fraud'
import { int } from '../lib/format'
import type { Summary } from '../lib/types'

const HEIGHT = 164
const PAD = 30
const TRACK_Y = 82

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, Math.max(280, width)] as const
}

/** Five scale labels, or three when the line is too narrow for them to breathe. */
function ticksFor(n: number, span: number): number[] {
  const top = n + 1
  const raw =
    span < 420
      ? [1, Math.round(top / 2), top]
      : [1, Math.round(top / 4), Math.round(top / 2), Math.round((3 * top) / 4), top]
  return [...new Set(raw)].filter((t) => t >= 1 && t <= top)
}

/** The same picture tells two stories: thresholds on the dashboard, rupee cutoffs on the fraud page. */
const WORDS = {
  rule: {
    value: (t: number) => int(t),
    band: 'Thresholds still possible',
    engine: "Engine's threshold",
    model: "Model's estimate",
    truth: 'Hidden rule',
    stored: 'Remembered rules',
    wrong: 'Answered wrongly',
    engineAt: (t: number) => `engine: θ = ${int(t)}`,
    engineRange: (count: number) => `${int(count)} thresholds still possible`,
    modelAt: (t: number) => `model: θ ≈ ${int(t)}`,
    truthAt: (t: number) => `hidden rule: θ = ${int(t)}`,
    moving: (a: number, b: number) => `hidden rule moving ${int(a)} → ${int(b)}`,
    random: 'Hidden rule: random labels, no threshold fits',
    pick: (t: number) => `Click to move the hidden rule to θ = ${int(t)}`,
    learning: 'Each label the engine buys halves the blue band.',
    converged: 'One threshold left: every answer is right until the rule changes.',
    stale: 'The rule moved: answers in the red zone are now wrong until a checked one exposes it.',
    robust: 'Robust mode keeps no band; the dot is where the model switches from 0 to 1.',
    tap: 'Click or tap the line to move the hidden rule.',
  },
  fraud: {
    value: money,
    band: 'Possible cutoffs',
    engine: "Engine's cutoff",
    model: "Engine's estimate",
    truth: 'Real cutoff (hidden)',
    stored: 'Remembered cutoffs',
    wrong: 'Judged wrongly',
    engineAt: (t: number) => `engine: fraud from ${money(t)}`,
    engineRange: (count: number) => `${int(count)} possible cutoffs`,
    modelAt: (t: number) => `engine: fraud from about ${money(t)}`,
    truthAt: (t: number) => `real: fraud from ${money(t)}`,
    moving: (a: number, b: number) => `real cutoff moving ${money(a)} → ${money(b)}`,
    random: 'Real fraud: random, no cutoff fits',
    pick: (t: number) => `Click to make fraud start at ${money(t)}`,
    learning: 'Each analyst check rules out half of the possible cutoffs.',
    converged: 'One cutoff left: every decision is right until fraudsters change tactics.',
    stale: 'Fraudsters moved the cutoff: decisions in the red zone are wrong until a checked one exposes it.',
    robust: 'The noise-tolerant engine keeps no range; the dot is its estimate.',
    tap: 'Click or tap the line to set where fraud starts.',
  },
  spam: {
    value: (t: number) => int(t),
    band: 'Possible cutoffs',
    engine: "Engine's cutoff",
    model: "Engine's estimate",
    truth: 'Where spam really starts (hidden)',
    stored: 'Cutoffs from earlier campaigns',
    wrong: 'Misfiled',
    engineAt: (t: number) => `engine: spam from score ${int(t)}`,
    engineRange: (count: number) => `${int(count)} possible cutoffs`,
    modelAt: (t: number) => `engine: spam from about score ${int(t)}`,
    truthAt: (t: number) => `real: spam from score ${int(t)}`,
    moving: (a: number, b: number) => `real cutoff moving ${int(a)} → ${int(b)}`,
    random: 'Real spam: random, no cutoff fits',
    pick: (t: number) => `Click to make spam start at score ${int(t)}`,
    learning: 'Each review rules out half of the possible cutoffs.',
    converged: 'One cutoff left: every email is filed right until spammers change their wording.',
    stale: 'Spammers moved the cutoff: emails in the red zone are misfiled until a report exposes it.',
    robust: 'The noise-tolerant engine keeps no range; the dot is its estimate.',
    tap: 'Click or tap the line to set where spam starts.',
  },
}

export interface LineMarker {
  value: number // an input, drawn between thresholds value and value + 1
  label: string
}

interface Props {
  summary: Summary
  marker?: LineMarker | null
  /** A fixed cutoff to draw for comparison, such as a filter that never adapts. */
  reference?: { value: number; label: string } | null
  onPick?: (theta: number) => void
  variant?: keyof typeof WORDS
}

/**
 * The thresholds 1..n+1 on a line. The band is every rule the engine still
 * considers possible; watching it collapse is watching the engine learn.
 */
export function NumberLine({ summary: s, marker, reference, onPick, variant = 'rule' }: Props) {
  const w = WORDS[variant]
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const n = s.n
  const span = width - 2 * PAD
  const x = (theta: number) => PAD + ((theta - 1) / n) * span
  const toTheta = (px: number) => Math.min(n + 1, Math.max(1, Math.round(1 + ((px - PAD) / span) * n)))
  const anchor = (px: number) => (px < PAD + 70 ? 'start' : px > width - PAD - 70 ? 'end' : 'middle')

  const exact = s.mode === 'exact'
  const lo = s.lo ?? 1
  const hi = s.hi ?? n + 1
  const converged = exact && lo === hi
  const estimate = s.theta_hat ?? lo

  // Where the engine's answers are now wrong: between its rule and the hidden one.
  const settled = converged || !exact
  const truth = s.in_family && !s.gradual ? s.theta : null
  const stale = settled && truth !== null && truth !== estimate
  const wrongFrom = stale ? Math.min(truth, estimate) : 0
  const wrongTo = stale ? Math.max(truth, estimate) : 0

  const engineLabel = !exact ? w.modelAt(estimate) : converged ? w.engineAt(lo) : w.engineRange(hi - lo + 1)
  const engineX = exact ? (converged ? x(lo) : (x(lo) + x(hi)) / 2) : x(estimate)

  const pointer = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect()
    return box ? toTheta(e.clientX - box.left) : null
  }

  const truthText = s.in_family
    ? s.gradual
      ? w.moving(s.gradual.from, s.gradual.to)
      : w.truthAt(s.theta ?? 0)
    : null
  const description = `${engineLabel}. ${truthText ?? w.random}.`

  const caption =
    onPick && hover !== null
      ? w.pick(hover)
      : marker
        ? marker.label
        : stale
          ? w.stale
          : !exact
            ? w.robust
            : converged
              ? w.converged
              : w.learning

  return (
    <div className="numberline" ref={ref}>
      <div className="legend" aria-hidden="true">
        {exact && (
          <span className="legend-item">
            <span className="key-rect" style={{ background: 'var(--wash)', boxShadow: 'inset 0 0 0 2px var(--series-1)' }} />
            {w.band}
          </span>
        )}
        <span className="legend-item">
          <svg width="12" height="12">
            <circle cx="6" cy="6" r="5" fill="var(--series-1)" />
          </svg>
          {exact ? w.engine : w.model}
        </span>
        <span className="legend-item">
          <svg width="12" height="12">
            <path d="M6 1l5 10H1z" fill="var(--ink)" />
          </svg>
          {w.truth}
        </span>
        {reference && (
          <span className="legend-item">
            <span className="key-dash" />
            {reference.label}
          </span>
        )}
        {s.memory.length > 0 && (
          <span className="legend-item">
            <svg width="6" height="12">
              <rect x="2" y="1" width="2" height="10" fill="var(--ink-2)" />
            </svg>
            {w.stored}
          </span>
        )}
        {stale && (
          <span className="legend-item">
            <span className="key-rect" style={{ background: 'var(--wrong)', boxShadow: 'inset 0 0 0 1.5px var(--critical)' }} />
            {w.wrong}
          </span>
        )}
      </div>

      <svg className="numberline-svg" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={description}>
        {/* the track and its scale */}
        <line x1={x(1)} x2={x(n + 1)} y1={TRACK_Y} y2={TRACK_Y} stroke="var(--axis)" strokeWidth="1.5" />
        {ticksFor(n, span).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TRACK_Y + 4} y2={TRACK_Y + 9} stroke="var(--axis)" />
            <text x={x(t)} y={HEIGHT - 6} textAnchor={anchor(x(t))} fontSize="12" fill="var(--muted)" className="num">
              {w.value(t)}
            </text>
          </g>
        ))}

        {/* answers that are now wrong */}
        {stale && (
          <g>
            <rect x={x(wrongFrom)} y={TRACK_Y - 14} width={Math.max(2, x(wrongTo) - x(wrongFrom))} height="28" fill="var(--wrong)" />
            <line x1={x(wrongFrom)} x2={x(wrongTo)} y1={TRACK_Y - 14} y2={TRACK_Y - 14} stroke="var(--critical)" strokeWidth="1.5" />
            <line x1={x(wrongFrom)} x2={x(wrongTo)} y1={TRACK_Y + 14} y2={TRACK_Y + 14} stroke="var(--critical)" strokeWidth="1.5" />
          </g>
        )}

        {/* version space */}
        {exact && (
          <g>
            <rect
              className="moving"
              x={x(lo) - (converged ? 1 : 0)}
              y={TRACK_Y - 13}
              width={Math.max(2, x(hi) - x(lo))}
              height="26"
              rx="3"
              fill="var(--wash)"
            />
            {!converged && (
              <>
                <rect className="moving" x={x(lo) - 1} y={TRACK_Y - 13} width="2" height="26" fill="var(--series-1)" />
                <rect className="moving" x={x(hi) - 1} y={TRACK_Y - 13} width="2" height="26" fill="var(--series-1)" />
              </>
            )}
          </g>
        )}

        {/* remembered rules (exact) or stored model boundaries (robust) */}
        {s.memory.map((m) => (
          <rect key={m} x={x(m) - 1} y={TRACK_Y - 29} width="2" height="10" rx="1" fill="var(--ink-2)" />
        ))}

        {/* the last point asked about (dashboard) or the last transaction (fraud page) */}
        {marker && (
          <rect
            x={x(marker.value + 0.5) - 4.5}
            y={TRACK_Y - 4.5}
            width="9"
            height="9"
            transform={`rotate(45 ${x(marker.value + 0.5)} ${TRACK_Y})`}
            fill="var(--surface)"
            stroke="var(--ink)"
            strokeWidth="1.6"
          />
        )}

        {/* a fixed cutoff, for comparison */}
        {reference && (
          <g>
            <line
              x1={x(reference.value)}
              x2={x(reference.value)}
              y1={TRACK_Y - 22}
              y2={TRACK_Y + 14}
              stroke="var(--ink-2)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          </g>
        )}

        {/* the engine's rule */}
        <circle className="moving" cx={exact ? x(converged ? lo : estimate) : x(estimate)} cy={TRACK_Y} r="6.5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
        <text x={engineX} y={TRACK_Y - 38} textAnchor={anchor(engineX)} fontSize="13" fill="var(--ink)" fontWeight="650">
          {engineLabel}
        </text>

        {/* the truth, which only the simulator knows */}
        {s.in_family && s.theta !== null && !s.gradual && (
          <g>
            <path className="moving" d={`M${x(s.theta)} ${TRACK_Y + 17} l6 11 h-12 z`} fill="var(--ink)" />
            <text x={x(s.theta)} y={TRACK_Y + 47} textAnchor={anchor(x(s.theta))} fontSize="13" fill="var(--ink)">
              {truthText}
            </text>
          </g>
        )}
        {s.gradual && (
          <g>
            <path d={`M${x(s.gradual.from)} ${TRACK_Y + 17} l6 11 h-12 z`} fill="none" stroke="var(--ink)" strokeWidth="1.5" />
            <path d={`M${x(s.gradual.to)} ${TRACK_Y + 17} l6 11 h-12 z`} fill="var(--ink)" />
            <text x={x(s.gradual.to)} y={TRACK_Y + 47} textAnchor={anchor(x(s.gradual.to))} fontSize="13" fill="var(--ink)">
              {`${truthText} (${Math.round(s.gradual.weight_new * 100)}% new)`}
            </text>
          </g>
        )}
        {!s.in_family && (
          <g>
            <rect x={x(1)} y={TRACK_Y + 17} width={span} height="11" rx="2" fill="var(--surface-3)" />
            <text x={width / 2} y={TRACK_Y + 47} textAnchor="middle" fontSize="13" fill="var(--ink)">
              {w.random}
            </text>
          </g>
        )}

        {/* click target: move the hidden rule here */}
        {onPick && hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={TRACK_Y - 20} y2={TRACK_Y + 30} stroke="var(--ink-2)" strokeWidth="1" />
        )}
        {onPick && (
          <rect
            className="track-hit"
            x={0}
            y={TRACK_Y - 32}
            width={width}
            height="66"
            fill="transparent"
            onPointerMove={(e) => setHover(pointer(e))}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => {
              const theta = pointer(e)
              if (theta !== null) onPick(theta)
            }}
          />
        )}
      </svg>

      <div className="numberline-caption">
        <span>{caption}</span>
        {onPick && <span>{w.tap}</span>}
      </div>
    </div>
  )
}
