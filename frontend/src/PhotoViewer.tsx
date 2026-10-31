import { useEffect, useRef, useState } from 'react'

interface Props {
  thumbUrl: string
  imageUrl: string
  alt: string
  height?: number
}

// Flat viewer for the full-resolution photo (equirectangular shown as is): wheel = zoom, drag = pan,
// double-click = reset. The thumbnail is shown while the original loads.
export default function PhotoViewer({ thumbUrl, imageUrl, alt, height = 260 }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ z: 1, x: 0, y: 0 })
  const [full, setFull] = useState(false)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  useEffect(() => {
    setView({ z: 1, x: 0, y: 0 })
    setFull(false)
  }, [imageUrl])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setView((v) => {
        const z = Math.max(1, Math.min(16, v.z * (e.deltaY < 0 ? 1.25 : 0.8)))
        // keep the point under the cursor in place
        const x = mx - ((mx - v.x) * z) / v.z
        const y = my - ((my - v.y) * z) / v.z
        return z === 1 ? { z, x: 0, y: 0 } : { z, x, y }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={box}
      className="viewer"
      style={{ height }}
      onPointerDown={(e) => {
        ;(e.target as Element).setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d && e.buttons & 1) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setView({ z: 1, x: 0, y: 0 })}
      title="Molette : zoom · glisser : déplacer · double-clic : recentrer"
    >
      <img
        src={full ? imageUrl : thumbUrl}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
      />
      {!full && <img className="preload" src={imageUrl} alt="" onLoad={() => setFull(true)} />}
      <span className="viewer-zoom">×{view.z.toFixed(1)}</span>
    </div>
  )
}
