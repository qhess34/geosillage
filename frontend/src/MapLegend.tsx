import { ReactNode, useState } from 'react'
import { AGE_CLASSES } from './panoramaxLayer'

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

const MAP: [ReactNode, string][] = [
  [dot('#2563eb'), 'photo, couleur de sa séquence'],
  [dot('#9ca3af'), 'photo non classée'],
  [dot('#6b7280'), 'photo exclue (case « Exclues »)'],
  [dot('#dc2626'), 'anomalie GPS (saut, sans GPS)'],
  [dot('#2563eb', '#7c3aed', 2), 'position corrigée à la main, interpolée ou recalée'],
  [dot('#facc15', '#111827', 2), 'photo courante'],
  [dot('rgba(250,204,21,0.75)', '#d97706', 1.5), 'photos sélectionnées'],
  [line('#7c3aed', '2 2'), 'déplacement depuis la position d\'origine (mode Positions)'],
  [line('#dc2626', '3 3'), 'photos sans position entre deux voisines'],
  [dot('#ea580c'), 'aperçu de la synchro (onglet Synchro)'],
]
const TIMELINE: [ReactNode, string][] = [
  [bar('#2563eb'), 'séquence'],
  [bar('#9ca3af'), 'photos non classées'],
  [bar('#d1d5db', 6, 4), 'photos exclues'],
  [bar('#d97706', 4, 1), 'en haut : point à vérifier (arrêt, écart…)'],
  [bar('#dc2626', 4, 9), 'en bas : anomalie GPS'],
  [bar('#111827', 12, 1), 'trait vertical : interruption de prise de vue'],
  [bar('rgba(250,204,21,0.5)'), 'plage sélectionnée'],
]

// panoramax: source of the coverage of photos already published, when shown on the map (null: hidden)
export default function MapLegend({ panoramax }: { panoramax: string | null }) {
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
        {open ? '▾' : '▸'} Légende
      </button>
      {open && (
        <div className="map-legend-body">
          <strong>Carte</strong>
          <ul>
            {MAP.map(([icon, label]) => (
              <li key={label}>
                {icon} {label}
              </li>
            ))}
          </ul>
          {panoramax && (
            <>
              <strong title={panoramax}>Couverture Panoramax</strong>
              <ul>
                {AGE_CLASSES.map((c) => (
                  <li key={c.label}>
                    {line(c.color)} photos 360° publiées il y a {c.label}
                  </li>
                ))}
                <li className="muted">survol d'une photo : date, appareil, auteur</li>
              </ul>
            </>
          )}
          <strong>Timeline</strong>
          <ul>
            {TIMELINE.map(([icon, label]) => (
              <li key={label}>
                {icon} {label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
