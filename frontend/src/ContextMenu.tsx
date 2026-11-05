import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}

// Context menu at the pointer (right click / long press on the map, the timeline or a sequence)
export default function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // kept inside the window
  const left = Math.max(4, Math.min(x, window.innerWidth - 270))
  const top = Math.max(4, Math.min(y, window.innerHeight - 40 - items.length * 34))
  return (
    <div ref={box} className="ctx-menu small-text" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="ctx-title muted">{title}</div>}
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            onClose()
            it.onClick()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
