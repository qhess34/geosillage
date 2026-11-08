import { ReactNode, useState } from 'react'
import { AGE_CLASSES } from './panoramaxLayer'
import { Key, t, useLang } from './i18n'

// Meaning of the colours and marks of the map and the timeline (folded by default, remembered)
const dot = (fill: string, stroke = '#ffffff', w = 1) => (
  <svg width="14" height="14" aria-hidden>
    <circle cx="7" cy="7" r="5" fill={fill} stroke={stroke} strokeWidth={w} />
  </svg>
)
const bar = (fill: string, h = 10, y = 2) => (
  <svg width="14" height="14" aria-hidden>
    <rect x="1" y={y} width="12" height={h} fill={fill} rx="1" />
  </svg>
)
const line = (color: string, dash?: string) => (
  <svg width="18" height="14" aria-hidden>
    <line x1="1" y1="7" x2="17" y2="7" stroke={color} strokeWidth="2" strokeDasharray={dash} />
  </svg>
)

const MAP: [ReactNode, Key][] = [
  [dot('#2563eb'), 'legend.photo'],
  [dot('#9ca3af'), 'legend.unassigned'],
  [dot('#6b7280'), 'legend.excluded'],
  [dot('#dc2626'), 'legend.gpsAnomaly'],
  [dot('#2563eb', '#7c3aed', 2), 'legend.corrected'],
  [dot('#facc15', '#111827', 2), 'legend.current'],
  [dot('rgba(250,204,21,0.75)', '#d97706', 1.5), 'legend.selected'],
  [line('#7c3aed', '2 2'), 'legend.moved'],
  [line('#dc2626', '3 3'), 'legend.noPosBetween'],
  [dot('#ea580c'), 'legend.syncPreview'],
]
const TIMELINE: [ReactNode, Key][] = [
  [bar('#2563eb'), 'legend.tlSeq'],
  [bar('#9ca3af'), 'legend.tlUnassigned'],
  [bar('#d1d5db', 6, 4), 'legend.tlExcluded'],
  [bar('#d97706', 4, 1), 'legend.tlTop'],
  [bar('#dc2626', 4, 9), 'legend.tlBottom'],
  [bar('#111827', 12, 1), 'legend.tlBreak'],
  [bar('rgba(250,204,21,0.5)'), 'legend.tlRange'],
]

// panoramax: source of the coverage of photos already published, when shown on the map (null: hidden)
export default function MapLegend({ panoramax }: { panoramax: string | null }) {
  useLang()
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem('pss-legend') === '1'
    } catch {
      return false
    }
  })
  const setOpen = (v: boolean) => {
    setOpenState(v)
    try {
      localStorage.setItem('pss-legend', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="map-legend small-text">
      <button className="small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {t('legend.title')}
      </button>
      {open && (
        <div className="map-legend-body">
          <strong>{t('legend.map')}</strong>
          <ul>
            {MAP.map(([icon, label]) => (
              <li key={label}>
                {icon} {t(label)}
              </li>
            ))}
          </ul>
          {panoramax && (
            <>
              <strong title={panoramax}>{t('legend.coverage')}</strong>
              <ul>
                {AGE_CLASSES.map((c) => (
                  <li key={c.label}>
                    {line(c.color)} {t('legend.published', { age: t(c.label) })}
                  </li>
                ))}
                <li className="muted">{t('legend.hover')}</li>
              </ul>
            </>
          )}
          <strong>{t('legend.timeline')}</strong>
          <ul>
            {TIMELINE.map(([icon, label]) => (
              <li key={label}>
                {icon} {t(label)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
