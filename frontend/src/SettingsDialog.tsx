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
  onError,
  onClose,
}: {
  project: Project
  overlay: OverlaySettings
  onOverlay: (o: OverlaySettings) => void
  custom: Basemap[]
  onRemoveBasemap: (id: string) => void
  onHeadingsSaved: () => void
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
        <HeadingSettings key={`${project.settings.heading_min_m}-${project.settings.heading_window_s}`} p={project} onSaved={onHeadingsSaved} onError={onError} />
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
