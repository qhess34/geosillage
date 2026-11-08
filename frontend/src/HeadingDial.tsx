import { useRef } from 'react'
import { t, useLang } from './i18n'

interface Props {
  value: number | null // final heading
  computed: number | null // computed heading (with sequence offset), shown as a thin line
  onChange: (deg: number) => void // while dragging
  onCommit: (deg: number) => void // on release
  size?: number
}

// Circular control: drag the arrow to set the heading (north up, clockwise). Shift = 5° steps.
export default function HeadingDial({ value, computed, onChange, onCommit, size = 120 }: Props) {
  useLang()
  const ref = useRef<SVGSVGElement>(null)
  const r = size / 2

  const angleAt = (e: React.PointerEvent, snap: boolean) => {
    const b = (ref.current as SVGSVGElement).getBoundingClientRect()
    const x = e.clientX - (b.left + b.width / 2)
    const y = e.clientY - (b.top + b.height / 2)
    let a = (Math.atan2(x, -y) * 180) / Math.PI
    a = (a + 360) % 360
    return snap ? (Math.round(a / 5) * 5) % 360 : Math.round(a * 10) / 10
  }

  const ray = (deg: number, len: number) => {
    const rad = (deg * Math.PI) / 180
    return [r + Math.sin(rad) * len, r - Math.cos(rad) * len]
  }

  const arrow = value != null ? ray(value, r - 12) : null
  const comp = computed != null ? ray(computed, r - 8) : null

  return (
    <svg
      ref={ref}
      className="dial"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="slider"
      aria-label={t('dial.label')}
      aria-valuemin={0}
      aria-valuemax={359.99}
      aria-valuenow={value ?? undefined}
      onPointerDown={(e) => {
        ;(e.target as Element).setPointerCapture(e.pointerId)
        onChange(angleAt(e, e.shiftKey))
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) onChange(angleAt(e, e.shiftKey))
      }}
      onPointerUp={(e) => onCommit(angleAt(e, e.shiftKey))}
    >
      <circle cx={r} cy={r} r={r - 2} className="dial-face" />
      {[0, 90, 180, 270].map((d) => {
        const [x, y] = ray(d, r - 14)
        return (
          <text key={d} x={x} y={y + 4} textAnchor="middle" className="dial-label">
            {{ 0: 'N', 90: 'E', 180: 'S', 270: t('dial.west') }[d]}
          </text>
        )
      })}
      {comp && <line x1={r} y1={r} x2={comp[0]} y2={comp[1]} className="dial-computed" />}
      {arrow && (
        <>
          <line x1={r} y1={r} x2={arrow[0]} y2={arrow[1]} className="dial-arrow" />
          <circle cx={arrow[0]} cy={arrow[1]} r={5} className="dial-knob" />
        </>
      )}
      <circle cx={r} cy={r} r={3} className="dial-knob" />
    </svg>
  )
}
