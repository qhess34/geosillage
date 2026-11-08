import { useEffect, useState } from 'react'
import { api, Project } from './api'
import { Basemap } from './basemaps'
import { Confirm } from './Dialogs'
import { getLang, Key, LANGS, setLang, t, useLang } from './i18n'
import { OverlaySettings, panoramaxPresets } from './panoramaxLayer'

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
  useLang()
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
      <div className="modal settings" role="dialog" aria-label={t('settings.title')}>
        <div className="row between">
          <h2>{t('settings.heading')}</h2>
          <button className="small" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="small-text">
          <h3>{t('settings.language')}</h3>
          <p className="muted">{t('settings.languageHelp')}</p>
          <select value={getLang()} onChange={(e) => setLang(e.target.value as 'fr' | 'en')} aria-label={t('settings.language')}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <OverlayUrl overlay={overlay} onSave={onOverlay} />
        <div className="small-text">
          <h3>{t('settings.basemaps.title')}</h3>
          {custom.length ? (
            <ul className="settings-list">
              {custom.map((b) => (
                <li key={b.id}>
                  <span>
                    <strong>{b.name}</strong> <span className="muted mono break">{b.url}</span>
                  </span>
                  <button className="small danger" onClick={() => setRemoving(b)}>
                    {t('common.remove')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('settings.basemaps.none')}</p>
          )}
        </div>
        {removing && (
          <Confirm
            title={t('settings.basemaps.removeTitle', { name: removing.name })}
            confirmLabel={t('common.remove')}
            danger
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              onRemoveBasemap(removing.id)
              setRemoving(null)
            }}
          >
            <p>{t('settings.basemaps.removeBody')}</p>
          </Confirm>
        )}
        <QualitySettings key={JSON.stringify(QUALITY_KEYS.map((k) => project.settings[k]))} p={project} onSaved={onQualitySaved} onError={onError} />
        <HeadingSettings key={`${project.settings.heading_min_m}-${project.settings.heading_window_s}`} p={project} onSaved={onHeadingsSaved} onError={onError} />
      </div>
    </div>
  )
}

const QUALITY_KEYS = ['stop_m', 'stop_min', 'spacing_m', 'dop_max', 'heading_diff'] as const
const QUALITY_FIELDS: { key: (typeof QUALITY_KEYS)[number]; min: number; max: number; step: number }[] = [
  { key: 'stop_min', min: 2, max: 100, step: 1 },
  { key: 'stop_m', min: 0.5, max: 50, step: 0.5 },
  { key: 'spacing_m', min: 1, max: 1000, step: 1 },
  { key: 'dop_max', min: 0.5, max: 50, step: 0.5 },
  { key: 'heading_diff', min: 10, max: 180, step: 5 },
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
      <h3>{t('settings.quality.title')}</h3>
      <p className="muted">{t('settings.quality.help')}</p>
      {QUALITY_FIELDS.map((f) => (
        <div key={f.key} className="form-row wide">
          <span>{t(`settings.quality.${f.key}` as Key)}</span>
          <span>
            <input
              className="num"
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={v[f.key]}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
              aria-label={t(`settings.quality.${f.key}` as Key)}
            />{' '}
            {t(`settings.quality.${f.key}.unit` as Key)}
          </span>
        </div>
      ))}
      <div className="row">
        <button className="small" onClick={save}>
          {t('common.save')}
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
      <h3>{t('settings.heading.title')}</h3>
      <p className="muted">{t('settings.heading.help')}</p>
      <div className="row wrap">
        <label>
          {t('settings.heading.minDist')} <input className="num" type="number" min={1} max={100} value={minM} onChange={(e) => setMinM(e.target.value)} /> m
        </label>
        <label>
          {t('settings.heading.window')} <input className="num" type="number" min={1} max={120} value={win} onChange={(e) => setWin(e.target.value)} /> s
        </label>
        <button className="small" onClick={save}>
          {t('settings.heading.save')}
        </button>
      </div>
    </div>
  )
}

function OverlayUrl({ overlay, onSave }: { overlay: OverlaySettings; onSave: (o: OverlaySettings) => void }) {
  const [url, setUrl] = useState(overlay.url)
  return (
    <div className="small-text">
      <h3>{t('settings.overlay.title')}</h3>
      <p className="muted">{t('settings.overlay.help')}</p>
      <div className="row wrap">
        {panoramaxPresets().map((p) => (
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
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://panoramax.example.org" aria-label={t('settings.overlay.other')} />
        <button className="small" type="submit">
          {t('common.save')}
        </button>
      </form>
    </div>
  )
}
