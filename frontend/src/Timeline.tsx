import { useEffect, useRef, useState } from 'react'
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
// Zoom: mouse wheel (around the cursor) or the − / + buttons; scroll: scrollbar, Shift+wheel or horizontal swipe.
const DRAG_PX = 8 // minimal horizontal movement for a drag to select a range
const MIN_SPAN = 20 // photos visible at the maximal zoom

export default function Timeline({ photos, sequences, selectedIdx, range, onPick }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const downX = useRef(0)
  const n = photos.length
  // visible window: photos [start, start + span)
  const [view, setView] = useState<{ start: number; span: number }>({ start: 0, span: Math.max(1, n) })
  const fullSpan = Math.max(1, n)
  const span = Math.min(fullSpan, Math.max(Math.min(MIN_SPAN, fullSpan), view.span))
  const start = Math.max(0, Math.min(fullSpan - span, view.start))
  const zoomed = span < fullSpan
  const setWindow = (st: number, sp: number) => {
    const s2 = Math.min(fullSpan, Math.max(Math.min(MIN_SPAN, fullSpan), sp))
    setView({ start: Math.max(0, Math.min(fullSpan - s2, st)), span: s2 })
  }
  const zoomAt = (factor: number, centerIdx: number) => {
    const s2 = Math.min(fullSpan, Math.max(Math.min(MIN_SPAN, fullSpan), span * factor))
    const ratio = (centerIdx - start) / span
    setWindow(centerIdx - ratio * s2, s2)
  }
  // a new project / an import: everything visible again
  useEffect(() => setWindowAll(), [n]) // eslint-disable-line react-hooks/exhaustive-deps
  function setWindowAll() {
    setView({ start: 0, span: Math.max(1, n) })
  }
  // the current photo stays visible when zoomed (navigation with ← →, clicks on the map)
  useEffect(() => {
    if (selectedIdx == null || !zoomed) return
    if (selectedIdx < start || selectedIdx >= start + span) setWindow(selectedIdx - span / 2, span)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx])
  // wheel: zoom around the cursor; Shift+wheel or horizontal swipe: scroll (not passive: the page must not scroll)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      if (!n) return
      e.preventDefault()
      const b = c.getBoundingClientRect()
      const horizontal = e.shiftKey ? e.deltaY : e.deltaX
      if (Math.abs(horizontal) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
        setWindow(start + (horizontal / b.width) * span, span)
      } else {
        const at = start + ((e.clientX - b.left) / b.width) * span
        zoomAt(e.deltaY > 0 ? 1.25 : 0.8, at)
      }
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  })

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
      if (!n) return
      const x = (i: number) => ((i - start) / span) * w
      const cw = w / span // width of one photo
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
          g.fillRect(x(i), 18, Math.max(1, cw), h - 36)
        } else {
          g.fillStyle = p.sequence_id != null ? (colors.get(p.sequence_id) as string) : '#9ca3af'
          g.fillRect(x(i), 10, Math.max(1, cw), h - 20)
        }
        if (p.flags & (FLAGS.GPS_JUMP | FLAGS.INVALID_COORD | FLAGS.NO_GPS)) {
          g.fillStyle = '#dc2626'
          g.fillRect(x(i), h - 8, Math.max(1, cw), 6)
        }
        if (p.flags & FLAGS.GAP_BEFORE) {
          g.fillStyle = '#111827'
          g.fillRect(x(i) - 1, 0, 2, h)
        }
      }
      if (selectedIdx != null) {
        g.fillStyle = '#facc15'
        g.strokeStyle = '#111827'
        const sx = x(selectedIdx) + cw / 2
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
  }, [photos, sequences, selectedIdx, range, start, span]) // eslint-disable-line react-hooks/exhaustive-deps

  const idxAt = (e: React.PointerEvent) => {
    const b = (canvas.current as HTMLCanvasElement).getBoundingClientRect()
    return Math.max(0, Math.min(n - 1, Math.floor(start + ((e.clientX - b.left) / b.width) * span)))
  }
  const center = selectedIdx ?? start + span / 2

  // scrollbar: drag the thumb or click the track
  const bar = useRef<HTMLDivElement>(null)
  const barDrag = useRef<{ x: number; start: number } | null>(null)
  const barIdx = (clientX: number) => {
    const b = (bar.current as HTMLDivElement).getBoundingClientRect()
    return ((clientX - b.left) / b.width) * fullSpan
  }

  return (
    <div className="timeline-wrap">
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
      <div className="timeline-zoom small-text">
        <button className="small" onClick={() => zoomAt(1.6, center)} disabled={!zoomed} title="Dézoomer (molette sur la timeline)" aria-label="Dézoomer la timeline">
          −
        </button>
        <button className="small" onClick={() => zoomAt(0.6, center)} disabled={span <= Math.min(MIN_SPAN, fullSpan)} title="Zoomer (molette sur la timeline)" aria-label="Zoomer la timeline">
          +
        </button>
        <button className="small" onClick={setWindowAll} disabled={!zoomed} title="Toute la sortie">
          Tout
        </button>
        {zoomed && (
          <span className="muted">
            {Math.floor(start) + 1}–{Math.min(n, Math.ceil(start + span))} / {n}
          </span>
        )}
      </div>
      {zoomed && (
        <div
          ref={bar}
          className="timeline-bar"
          title="Faire glisser pour parcourir la sortie"
          onPointerDown={(e) => {
            ;(e.target as Element).setPointerCapture(e.pointerId)
            const at = barIdx(e.clientX)
            if (at < start || at > start + span) setWindow(at - span / 2, span) // click on the track: jump there
            barDrag.current = { x: e.clientX, start: at < start || at > start + span ? at - span / 2 : start }
          }}
          onPointerMove={(e) => {
            const d = barDrag.current
            if (!d || !(e.buttons & 1)) return
            const b = (bar.current as HTMLDivElement).getBoundingClientRect()
            setWindow(d.start + ((e.clientX - d.x) / b.width) * fullSpan, span)
          }}
          onPointerUp={() => (barDrag.current = null)}
        >
          <div className="timeline-thumb" style={{ left: `${(start / fullSpan) * 100}%`, width: `${Math.max(2, (span / fullSpan) * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
