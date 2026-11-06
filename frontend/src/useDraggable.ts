import { useRef, useState } from 'react'

// A floating window moved by its title bar, kept inside its positioned parent (the map area). Returns the ref of
// the window, its style (null position: the CSS one) and the pointer handlers of the title bar.
export function useDraggable<T extends HTMLElement>() {
  const box = useRef<T>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      const el = box.current
      if (!el) return
      const r = el.getBoundingClientRect()
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      ;(e.target as Element).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const el = box.current
      if (!drag.current || !el || !(e.buttons & 1)) return
      const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect()
      if (!parent) return
      // the whole window stays inside the map area (it must not cover the side panel)
      const r = el.getBoundingClientRect()
      const left = Math.max(0, Math.min(parent.width - r.width, e.clientX - parent.left - drag.current.dx))
      const top = Math.max(0, Math.min(parent.height - Math.min(r.height, 40), e.clientY - parent.top - drag.current.dy))
      setPos({ left, top })
    },
    onPointerUp: () => {
      drag.current = null
    },
  }
  const style = pos ? { left: pos.left, top: pos.top, right: 'auto' } : undefined
  return { box, style, handlers }
}
