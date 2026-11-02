import { useEffect, useRef } from 'react'
import { FLAGS, PhotoRow, seqColor, Sequence } from './api'

interface Props {
  photos: PhotoRow[]
  sequences: Sequence[]
  selectedIdx: number | null
  range: [number, number] | null
  onPick: (idx: number, extend: boolean) => void
}

// Chronological strip: one column per photo (x = index), coloured by sequence.
// Click: go to photo. Shift+click or drag: select a range.
const DRAG_PX = 8 // minimal horizontal movement for a drag to select a range

export default function Timeline({ photos, sequences, selectedIdx, range, onPick }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const downX = useRef(0)

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const draw = () => {
      const w = c.clientWidth
      const h = c.clientHeight
      const dpr = window.devicePixelRatio || 1
      c.width = w * dpr
      c.height = h * dpr
      const g = c.getContext('2d') as CanvasRenderingContext2D
      g.scale(dpr, dpr)
      g.clearRect(0, 0, w, h)
      const n = photos.length
      if (!n) return
      const x = (i: number) => (i / n) * w
      const colors = new Map(sequences.map((s) => [s.id, seqColor(sequences, s.id)]))
      if (range) {
        g.fillStyle = 'rgba(250, 204, 21, 0.35)'
        g.fillRect(x(range[0]), 0, Math.max(2, x(range[1] + 1) - x(range[0])), h)
      }
      for (let i = 0; i < n; i++) {
        const p = photos[i]
        if (p.excluded) {
          // excluded photos: a hole in the strip
          g.fillStyle = '#d1d5db'
          g.fillRect(x(i), 18, Math.max(1, w / n), h - 36)
        } else {
          g.fillStyle = p.sequence_id != null ? (colors.get(p.sequence_id) as string) : '#9ca3af'
          g.fillRect(x(i), 10, Math.max(1, w / n), h - 20)
        }
        if (p.flags & (FLAGS.GPS_JUMP | FLAGS.INVALID_COORD | FLAGS.NO_GPS)) {
          g.fillStyle = '#dc2626'
          g.fillRect(x(i), h - 8, Math.max(1, w / n), 6)
        }
        if (p.flags & FLAGS.GAP_BEFORE) {
          g.fillStyle = '#111827'
          g.fillRect(x(i) - 1, 0, 2, h)
        }
      }
      if (selectedIdx != null) {
        g.fillStyle = '#facc15'
        g.strokeStyle = '#111827'
        const sx = x(selectedIdx) + w / n / 2
        g.beginPath()
        g.moveTo(sx - 6, 0)
        g.lineTo(sx + 6, 0)
        g.lineTo(sx, 9)
        g.closePath()
        g.fill()
        g.stroke()
        g.fillRect(sx - 1, 9, 2, h - 9)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => ro.disconnect()
  }, [photos, sequences, selectedIdx, range])

  const idxAt = (e: React.PointerEvent) => {
    const b = (canvas.current as HTMLCanvasElement).getBoundingClientRect()
    return Math.max(0, Math.min(photos.length - 1, Math.floor(((e.clientX - b.left) / b.width) * photos.length)))
  }

  return (
    <canvas
      ref={canvas}
      className="timeline"
      title="Clic : aller à la photo · Maj+clic ou glisser : sélectionner une plage"
      onPointerDown={(e) => {
        if (!photos.length) return
        ;(e.target as Element).setPointerCapture(e.pointerId)
        dragging.current = true
        downX.current = e.clientX
        onPick(idxAt(e), e.shiftKey)
      }}
      onPointerMove={(e) => {
        // a range only after a real drag: a click with a slight mouse movement must not select hundreds of photos
        if (dragging.current && e.buttons & 1 && Math.abs(e.clientX - downX.current) >= DRAG_PX) onPick(idxAt(e), true)
      }}
      onPointerUp={() => (dragging.current = false)}
    />
  )
}
