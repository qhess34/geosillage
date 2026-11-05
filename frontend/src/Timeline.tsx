import { useEffect, useRef, useState } from 'react'
import { FLAGS, PhotoRow, QualityIssue, seqColor, Sequence } from './api'
import { fmtTime } from './format'

interface Props {
  photos: PhotoRow[]
  sequences: Sequence[]
  selectedIdx: number | null
  range: [number, number] | null
  onPick: (idx: number, extend: boolean) => void
  onContextMenu?: (idx: number, x: number, y: number) => void // right click
  warnings?: QualityIssue[] // points to check (stops, spacing…): amber marks above the strip
  thumbUrl?: (photoId: number) => string // hover bubble: thumbnail of the photo under the pointer
  storageKey?: string // zoom / scroll remembered under this key (reopening the project)
}

// Chronological strip: one column per photo (x = index), coloured by sequence.
// Click: go to photo. Shift+click or drag: select a range.
// Zoom: mouse wheel (around the cursor) or the − / + buttons; scroll: scrollbar, Shift+wheel or horizontal swipe.
const DRAG_PX = 8 // minimal horizontal movement for a drag to select a range
const MIN_SPAN = 20 // photos visible at the maximal zoom

export default function Timeline({ photos, sequences, selectedIdx, range, onPick, onContextMenu, warnings, thumbUrl, storageKey }: Props) {
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null)
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
  // a new project / an import: everything visible again, unless this ride was left zoomed (same number of photos)
  useEffect(() => {
    try {
      const v = storageKey && JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (v && v.n === n && n > 0) return setView({ start: v.start, span: v.span })
    } catch {
      /* ignore */
    }
    setWindowAll()
  }, [n]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!storageKey || !n) return
    try {
      localStorage.setItem(storageKey, JSON.stringify({ n, start: view.start, span: view.span }))
    } catch {
      /* ignore */
    }
  }, [storageKey, n, view])
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
      // points to check: amber marks at the top (the photos concerned stay as they are)
      g.fillStyle = '#d97706'
      for (const wr of warnings ?? []) {
        if (wr.end_idx < start || wr.start_idx >= start + span) continue
        g.fillRect(x(wr.start_idx), 2, Math.max(3, x(wr.end_idx + 1) - x(wr.start_idx)), 6)
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
  }, [photos, sequences, selectedIdx, range, start, span, warnings]) // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="timeline-row">
    <canvas
      ref={canvas}
      className="timeline"
      onContextMenu={(e) => {
        if (!onContextMenu || !photos.length) return
        e.preventDefault()
        onContextMenu(idxAt(e as unknown as React.PointerEvent), e.clientX, e.clientY)
      }}
      onPointerDown={(e) => {
        if (!photos.length || e.button === 2) return
        ;(e.target as Element).setPointerCapture(e.pointerId)
        dragging.current = true
        downX.current = e.clientX
        onPick(idxAt(e), e.shiftKey)
      }}
      onPointerLeave={() => setHover(null)}
      onPointerMove={(e) => {
        const b = (e.target as HTMLElement).getBoundingClientRect()
        if (photos.length && !(e.buttons & 1)) setHover({ idx: idxAt(e), x: Math.max(106, Math.min(b.width - 106, e.clientX - b.left)) })
        else setHover(null)
        // a range only after a real drag: a click with a slight mouse movement must not select hundreds of photos
        if (dragging.current && e.buttons & 1 && Math.abs(e.clientX - downX.current) >= DRAG_PX) onPick(idxAt(e), true)
      }}
      onPointerUp={() => (dragging.current = false)}
    />
      {hover && photos[hover.idx] && <HoverBubble p={photos[hover.idx]} x={hover.x} sequences={sequences} warnings={warnings} thumbUrl={thumbUrl} />}
      <div className="timeline-zoom small-text">
        <div className="zoom-buttons">
        <button className="small" onClick={() => zoomAt(1.6, center)} disabled={!zoomed} title="Dézoomer (molette sur la timeline)" aria-label="Dézoomer la timeline">
          −
        </button>
        <button className="small" onClick={() => zoomAt(0.6, center)} disabled={span <= Math.min(MIN_SPAN, fullSpan)} title="Zoomer (molette sur la timeline)" aria-label="Zoomer la timeline">
          +
        </button>
        <button className="small" onClick={setWindowAll} disabled={!zoomed} title="Toute la sortie">
          Tout
        </button>
        </div>
        {zoomed && (
          <span className="muted">
            {Math.floor(start) + 1}–{Math.min(n, Math.ceil(start + span))} / {n}
          </span>
        )}
      </div>
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

// Bubble above the strip: photo under the pointer (thumbnail, number, time, sequence, what to check there)
function HoverBubble({ p, x, sequences, warnings, thumbUrl }: { p: PhotoRow; x: number; sequences: Sequence[]; warnings?: QualityIssue[]; thumbUrl?: (id: number) => string }) {
  const seq = sequences.find((s) => s.id === p.sequence_id)
  const notes = [
    p.excluded ? 'exclue' : null,
    p.flags & FLAGS.GPS_JUMP ? 'saut GPS' : null,
    p.flags & (FLAGS.NO_GPS | FLAGS.INVALID_COORD) && p.lat == null ? 'sans position' : null,
    p.flags & FLAGS.GAP_BEFORE ? 'interruption avant' : null,
    ...(warnings ?? []).filter((w) => p.idx >= w.start_idx && p.idx <= w.end_idx).map((w) => w.detail),
  ].filter(Boolean)
  return (
    <div className="timeline-bubble small-text" style={{ left: x }}>
      {thumbUrl && p.thumb === 1 && <img src={thumbUrl(p.id)} alt="" />}
      <div>
        <strong>Photo {p.idx + 1}</strong> · {fmtTime(p.ts, false)}
      </div>
      <div className="muted">
        <span className="chip" style={{ background: seqColor(sequences, p.sequence_id) }} /> {seq ? seq.name : 'non classée'}
      </div>
      {notes.length > 0 && <div className="warn-text">{notes.join(' · ')}</div>}
    </div>
  )
}
