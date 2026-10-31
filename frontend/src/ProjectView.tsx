import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, FLAG_LABELS, Job, PhotoDetail, PhotoRow, Project } from './api'
import { Basemap, BUILTIN_BASEMAPS, loadCustomBasemaps, saveCustomBasemaps } from './basemaps'
import { fmtCoord, fmtDistance, fmtDuration, fmtSize, fmtTime } from './format'
import ImportDialog from './ImportDialog'
import PhotoMap from './PhotoMap'

const JOB_LABELS: Record<string, string> = {
  import: 'Import',
  thumbnails: 'Miniatures',
  check_files: 'Vérification des fichiers',
}

function Summary({ p }: { p: Project }) {
  const s = p.summary
  const row = (label: string, value: React.ReactNode, warn = false) => (
    <tr className={warn ? 'warn' : ''}>
      <th>{label}</th>
      <td>{value}</td>
    </tr>
  )
  return (
    <table className="summary">
      <tbody>
        {row('Photos', s.total)}
        {row('Géolocalisées', s.geolocated)}
        {row('Sans GPS', s.no_gps, s.no_gps > 0)}
        {row('Sans date', s.no_date, s.no_date > 0)}
        {row('Doublons', s.duplicates, s.duplicates > 0)}
        {row('Anomalies GPS', `${s.gps_anomalies} (sauts : ${s.gps_jumps})`, s.gps_anomalies > 0)}
        {row('Interruptions', s.interruptions, s.interruptions > 0)}
        {row('Illisibles', s.unreadable, s.unreadable > 0)}
        {s.missing_files > 0 && row('Fichiers introuvables', s.missing_files, true)}
        {row('Photos 360°', s.is_360)}
        {row('Début', fmtTime(s.start))}
        {row('Fin', fmtTime(s.end))}
        {row('Durée', fmtDuration(s.duration_s))}
        {row('Distance', `≈ ${fmtDistance(s.distance_m)}`)}
        {row('Miniatures', `${s.thumbs_done} / ${s.total}${s.thumbs_failed ? ` (${s.thumbs_failed} en échec)` : ''}`)}
        {s.cameras.length > 0 &&
          row(
            'Caméras',
            s.cameras.map((c) => `${c.make ?? '?'} ${c.model ?? ''} (${c.count})`).join(', '),
          )}
      </tbody>
    </table>
  )
}

function PhotoPanel({ projectId, photo, count }: { projectId: string; photo: PhotoDetail; count: number }) {
  return (
    <div className="photo-panel">
      {photo.thumb === 1 ? (
        <a href={api.imageUrl(projectId, photo.id)} target="_blank" rel="noreferrer" title="Ouvrir l'original">
          <img className="thumb" src={api.thumbUrl(projectId, photo.id)} alt={photo.filename} />
        </a>
      ) : (
        <div className="thumb placeholder">{photo.thumb === -1 ? 'Image illisible' : 'Miniature en cours…'}</div>
      )}
      <div className="photo-title">
        <strong>{photo.filename}</strong>
        <span className="muted">
          {photo.idx + 1} / {count}
        </span>
      </div>
      <table className="summary">
        <tbody>
          <tr>
            <th>Date</th>
            <td>{photo.ts_text ?? '—'}</td>
          </tr>
          <tr>
            <th>GPS (original)</th>
            <td className="mono">{fmtCoord(photo.lat_orig, photo.lon_orig)}</td>
          </tr>
          <tr>
            <th>Heure GPS</th>
            <td>{fmtTime(photo.gps_ts)}</td>
          </tr>
          <tr>
            <th>Cap EXIF</th>
            <td>{photo.heading_exif != null ? `${photo.heading_exif}°` : 'absent'}</td>
          </tr>
          <tr>
            <th>Caméra</th>
            <td>
              {photo.make} {photo.model} {photo.is_360 ? '· 360°' : ''}
            </td>
          </tr>
          <tr>
            <th>Image</th>
            <td>
              {photo.width}×{photo.height} · {fmtSize(photo.size)}
            </td>
          </tr>
          <tr>
            <th>Fichier</th>
            <td className="mono small-text break">{photo.path}</td>
          </tr>
        </tbody>
      </table>
      {photo.flag_names.length > 0 && (
        <ul className="flags">
          {photo.flag_names.map((f) => (
            <li key={f}>{FLAG_LABELS[f] ?? f}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function JobBar({ jobs, projectId }: { jobs: Job[]; projectId: string }) {
  const running = jobs.filter((j) => j.state === 'running')
  const last = jobs[0]
  return (
    <footer className="statusbar">
      {running.length ? (
        running.map((j) => (
          <span key={j.id} className="job">
            {JOB_LABELS[j.kind] ?? j.kind} : {j.message ?? ''} {j.total ? `${j.done}/${j.total}` : ''}
            {j.total > 0 && <progress value={j.done} max={j.total} />}
            <button className="small" onClick={() => api.cancelJob(projectId, j.id)}>
              Annuler
            </button>
          </span>
        ))
      ) : last ? (
        <span className={last.state === 'error' ? 'error' : 'muted'}>
          Dernière tâche : {JOB_LABELS[last.kind] ?? last.kind} —{' '}
          {{ done: 'terminée', error: 'erreur', cancelled: 'annulée', interrupted: 'interrompue', running: 'en cours' }[last.state]}
          {last.message ? ` (${last.message})` : ''}
        </span>
      ) : (
        <span className="muted">Prêt</span>
      )}
    </footer>
  )
}

export default function ProjectView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null)
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState<Basemap[]>(loadCustomBasemaps)
  const basemaps = useMemo(() => [...BUILTIN_BASEMAPS, ...custom], [custom])
  const [basemapId, setBasemapId] = useState(() => {
    try {
      return localStorage.getItem('pss-basemap') || 'osm'
    } catch {
      return 'osm'
    }
  })
  const basemap = basemaps.find((b) => b.id === basemapId) ?? basemaps[0]
  const [panelWidth, setPanelWidth] = useState(380)
  const lastPhotosKey = useRef('')

  const refresh = useCallback(async () => {
    try {
      const p = await api.project(projectId)
      setProject(p)
      // Reload photo list when the content changed (count, thumbs, analysis)
      const key = `${p.summary.total}-${p.summary.thumbs_done}-${p.summary.thumbs_failed}-${p.summary.gps_jumps}-${p.summary.missing_files}`
      if (key !== lastPhotosKey.current) {
        lastPhotosKey.current = key
        setPhotos(await api.photos(projectId))
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const running = project?.jobs.some((j) => j.state === 'running')
  useEffect(() => {
    if (!running) return
    const t = setInterval(refresh, 1000)
    return () => clearInterval(t)
  }, [running, refresh])

  useEffect(() => {
    if (selected == null) {
      setDetail(null)
      return
    }
    api.photo(projectId, selected).then(setDetail, () => setDetail(null))
  }, [projectId, selected, photos])

  // Keyboard navigation in chronological order
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select') || !photos.length) return
      const i = photos.findIndex((p) => p.id === selected)
      const step = e.shiftKey ? 10 : 1
      if (e.key === 'ArrowRight') setSelected(photos[Math.min(photos.length - 1, i < 0 ? 0 : i + step)].id)
      else if (e.key === 'ArrowLeft') setSelected(photos[Math.max(0, i < 0 ? 0 : i - step)].id)
      else if (e.key === 'Home') setSelected(photos[0].id)
      else if (e.key === 'End') setSelected(photos[photos.length - 1].id)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photos, selected])

  const chooseBasemap = (id: string) => {
    if (id === '__add') {
      const name = prompt('Nom du fond de carte')
      const url = name && prompt('URL XYZ (avec {z}, {x}, {y})', 'https://…/{z}/{x}/{y}.png')
      if (!name || !url || !url.includes('{z}')) return
      const attribution = prompt('Attribution (obligatoire selon le fournisseur)') || ''
      const b: Basemap = { id: `custom-${Date.now()}`, name, url, attribution, maxzoom: 19, custom: true }
      const list = [...custom, b]
      setCustom(list)
      saveCustomBasemaps(list)
      id = b.id
    }
    setBasemapId(id)
    try {
      localStorage.setItem('pss-basemap', id)
    } catch {
      /* ignore */
    }
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    const move = (ev: MouseEvent) => setPanelWidth(Math.max(260, Math.min(800, startW - (ev.clientX - startX))))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (!project) return <div className="home">{error ? <p className="error">{error}</p> : 'Chargement…'}</div>

  return (
    <div className="workspace">
      <header className="toolbar">
        <button onClick={onBack} title="Retour aux projets">
          ←
        </button>
        <strong className="ellipsis">{project.name}</strong>
        <button className="primary" onClick={() => setShowImport(true)}>
          Importer des photos
        </button>
        <button onClick={() => api.checkFiles(projectId).then(refresh)} title="Signaler les fichiers sources introuvables">
          Vérifier les fichiers
        </button>
        {project.summary.thumbs_failed > 0 && (
          <button onClick={() => api.retryThumbs(projectId).then(refresh)}>Relancer les miniatures en échec</button>
        )}
        <span className="spacer" />
        <label className="muted">
          Fond{' '}
          <select value={basemap.id} onChange={(e) => chooseBasemap(e.target.value)}>
            {basemaps.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="__add">+ Ajouter un fond XYZ…</option>
          </select>
        </label>
      </header>
      {error && <div className="error banner">{error}</div>}
      <main className="main" style={{ gridTemplateColumns: `1fr 6px ${panelWidth}px` }}>
        <PhotoMap photos={photos} basemap={basemap} selectedId={selected} onSelect={setSelected} />
        <div className="resizer" onMouseDown={startResize} title="Redimensionner" />
        <aside className="side">
          {detail ? (
            <>
              <PhotoPanel projectId={projectId} photo={detail} count={photos.length} />
              <p className="muted small-text">← → : photo précédente / suivante · Maj : par 10 · Début / Fin</p>
            </>
          ) : (
            <p className="muted">
              {photos.length ? 'Cliquez sur une photo de la carte, ou utilisez ← →.' : 'Importez un dossier de photos pour commencer.'}
            </p>
          )}
          <h3>Bilan d'importation</h3>
          <Summary p={project} />
          {project.source_dirs.length > 0 && (
            <>
              <h3>Dossiers sources</h3>
              <ul className="sources">
                {project.source_dirs.map((d) => (
                  <li key={d} className="mono small-text break">
                    {d}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </main>
      <JobBar jobs={project.jobs} projectId={projectId} />
      {showImport && <ImportDialog projectId={projectId} onClose={() => setShowImport(false)} onStarted={refresh} />}
    </div>
  )
}
