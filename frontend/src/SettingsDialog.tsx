import { useEffect, useState } from 'react'
import { api, Project } from './api'
import { Basemap } from './basemaps'
import { Confirm } from './Dialogs'
import { OverlaySettings, PANORAMAX_PRESETS } from './panoramaxLayer'

// Settings (button ⚙ of the toolbar): display of the map for every ride, heading computation of this project
export default function SettingsDialog({
  project,
  overlay,
  onOverlay,
  custom,
  onRemoveBasemap,
  onHeadingsSaved,
  onQualitySaved,
  onError,
  onClose,
}: {
  project: Project
  overlay: OverlaySettings
  onOverlay: (o: OverlaySettings) => void
  custom: Basemap[]
  onRemoveBasemap: (id: string) => void
  onHeadingsSaved: () => void
  onQualitySaved: () => void // thresholds of the points to check changed: recompute them
  onError: (m: string) => void
  onClose: () => void
}) {
  const [removing, setRemoving] = useState<Basemap | null>(null) // background map to remove, once confirmed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role=alertdialog]')) {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-label="Réglages">
        <div className="row between">
          <h2>⚙ Réglages</h2>
          <button className="small" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </div>
        <OverlayUrl overlay={overlay} onSave={onOverlay} />
        <div className="small-text">
          <h3>Fonds de carte ajoutés (toutes les sorties)</h3>
          {custom.length ? (
            <ul className="settings-list">
              {custom.map((b) => (
                <li key={b.id}>
                  <span>
                    <strong>{b.name}</strong> <span className="muted mono break">{b.url}</span>
                  </span>
                  <button className="small danger" onClick={() => setRemoving(b)}>
                    Retirer
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Aucun : « + Ajouter un fond XYZ… » dans la liste des fonds de carte (contrôles de la carte).</p>
          )}
        </div>
        {removing && (
          <Confirm
            title={`Retirer le fond « ${removing.name} » ?`}
            confirmLabel="Retirer"
            danger
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              onRemoveBasemap(removing.id)
              setRemoving(null)
            }}
          >
            <p>Il disparaît de la liste des fonds de carte de toutes les sorties. Pour le retrouver, il faudra l'ajouter de nouveau.</p>
          </Confirm>
        )}
        <QualitySettings key={JSON.stringify(QUALITY_KEYS.map((k) => project.settings[k]))} p={project} onSaved={onQualitySaved} onError={onError} />
        <HeadingSettings key={`${project.settings.heading_min_m}-${project.settings.heading_window_s}`} p={project} onSaved={onHeadingsSaved} onError={onError} />
      </div>
    </div>
  )
}

const QUALITY_KEYS = ['stop_m', 'stop_min', 'spacing_m', 'dop_max', 'heading_diff'] as const
const QUALITY_FIELDS: { key: (typeof QUALITY_KEYS)[number]; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: 'stop_min', label: 'Arrêt : au moins', unit: 'photos de suite', min: 2, max: 100, step: 1 },
  { key: 'stop_m', label: '…à moins de', unit: 'm les unes des autres', min: 0.5, max: 50, step: 0.5 },
  { key: 'spacing_m', label: 'Grand écart : plus de', unit: 'm entre deux photos', min: 1, max: 1000, step: 1 },
  { key: 'dop_max', label: 'Précision GPS faible : DOP au-dessus de', unit: '', min: 0.5, max: 50, step: 0.5 },
  { key: 'heading_diff', label: 'Cap à vérifier : écart de plus de', unit: '° avec le cap calculé', min: 10, max: 180, step: 5 },
]

// Thresholds of the points to check (quality.py), for this project
function QualitySettings({ p, onSaved, onError }: { p: Project; onSaved: () => void; onError: (m: string) => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(QUALITY_KEYS.map((k) => [k, String(p.settings[k])])))
  const save = () =>
    api
      .updateProject(p.id, { settings: Object.fromEntries(QUALITY_KEYS.map((k) => [k, Number(v[k])])) })
      .then(onSaved, (e) => onError(e.message))
  return (
    <div className="small-text">
      <h3>Points à vérifier (ce projet)</h3>
      <p className="muted">Seuils des points signalés dans les étapes « Doublons et arrêts » et « Correction GPS ».</p>
      {QUALITY_FIELDS.map((f) => (
        <div key={f.key} className="form-row wide">
          <span>{f.label}</span>
          <span>
            <input
              className="num"
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={v[f.key]}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
              aria-label={f.label}
            />{' '}
            {f.unit}
          </span>
        </div>
      ))}
      <div className="row">
        <button className="small" onClick={save}>
          Enregistrer
        </button>
      </div>
    </div>
  )
}

function HeadingSettings({ p, onSaved, onError }: { p: Project; onSaved: () => void; onError: (m: string) => void }) {
  const [minM, setMinM] = useState(String(p.settings.heading_min_m))
  const [win, setWin] = useState(String(p.settings.heading_window_s))
  const save = () =>
    api
      .updateProject(p.id, { settings: { heading_min_m: Number(minM), heading_window_s: Number(win) } })
      .then(onSaved, (e) => onError(e.message))
  return (
    <div className="small-text">
      <h3>Calcul du cap (ce projet)</h3>
      <p className="muted">
        Le cap d'une photo est la direction vers le premier point suivant situé à au moins cette distance (cherché dans la
        fenêtre de temps). Les caps manuels ne sont jamais recalculés.
      </p>
      <div className="row wrap">
        <label>
          Distance min. <input className="num" type="number" min={1} max={100} value={minM} onChange={(e) => setMinM(e.target.value)} /> m
        </label>
        <label>
          Fenêtre <input className="num" type="number" min={1} max={120} value={win} onChange={(e) => setWin(e.target.value)} /> s
        </label>
        <button className="small" onClick={save}>
          Enregistrer et recalculer
        </button>
      </div>
    </div>
  )
}

function OverlayUrl({ overlay, onSave }: { overlay: OverlaySettings; onSave: (o: OverlaySettings) => void }) {
  const [url, setUrl] = useState(overlay.url)
  return (
    <div className="small-text">
      <h3>Surcouche Panoramax (toutes les sorties)</h3>
      <p className="muted">
        Photos 360° déjà publiées affichées par le bouton « Panoramax » des contrôles de la carte : toutes les instances
        (méta-catalogue) ou une seule instance.
      </p>
      <div className="row wrap">
        {PANORAMAX_PRESETS.map((p) => (
          <label key={p.url}>
            <input
              type="radio"
              name="pnx-source"
              checked={overlay.url === p.url}
              onChange={() => {
                setUrl(p.url)
                onSave({ ...overlay, url: p.url })
              }}
            />{' '}
            {p.label}
          </label>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const u = url.trim().replace(/\/+$/, '')
          if (/^https?:\/\//.test(u)) onSave({ ...overlay, url: u })
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://panoramax.example.org" aria-label="Autre instance Panoramax" />
        <button className="small" type="submit">
          Enregistrer
        </button>
      </form>
    </div>
  )
}
