import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, FLAG_LABELS, Job, PhotoDetail, PhotoRow, Project, SeqState, Sequence, UndoState } from './api'
import { Basemap, BUILTIN_BASEMAPS, loadCustomBasemaps, saveCustomBasemaps } from './basemaps'
import ExportTab from './ExportTab'
import { fmtCoord, fmtDistance, fmtDuration, fmtSize, fmtTime } from './format'
import HeadingDial from './HeadingDial'
import ImportDialog from './ImportDialog'
import PhotoMap from './PhotoMap'
import SequencesTab from './SequencesTab'
import Timeline from './Timeline'

const JOB_LABELS: Record<string, string> = {
  import: 'Import',
  thumbnails: 'Miniatures',
  check_files: 'Vérification des fichiers',
  export: 'Export',
}

const SHORTCUTS: [string, string][] = [
  ['← / →', 'Photo précédente / suivante (Maj : par 10)'],
  ['Début / Fin', 'Première / dernière photo'],
  ['Page ↑ / Page ↓', 'Séquence précédente / suivante'],
  ['D / F', 'Début / fin de la plage sur la photo courante'],
  ['S', 'Créer une séquence avec la plage'],
  ['C', 'Couper la séquence avant la photo courante'],
  ['Suppr', 'Retirer la photo courante de sa séquence'],
  ['Échap', 'Effacer la plage'],
  ['[ / ]', 'Cap de la photo −1° / +1° (Maj : 5°)'],
  ['Ctrl+Z / Ctrl+Y', 'Annuler / rétablir'],
  ['?', 'Cette aide'],
]

function HeadingSettings({ p, onSaved, onError }: { p: Project; onSaved: () => void; onError: (m: string) => void }) {
  const [minM, setMinM] = useState(String(p.settings.heading_min_m))
  const [win, setWin] = useState(String(p.settings.heading_window_s))
  const save = () =>
    api
      .updateProject(p.id, { settings: { heading_min_m: Number(minM), heading_window_s: Number(win) } })
      .then(onSaved, (e) => onError(e.message))
  return (
    <div className="small-text">
      <h3>Calcul du cap</h3>
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
        {row('Caps', `${p.headings.computed} calculés, ${p.headings.manual} manuels, ${p.headings.uncertain} incertains`, p.headings.uncertain > 0)}
        {s.cameras.length > 0 && row('Caméras', s.cameras.map((c) => `${c.make ?? '?'} ${c.model ?? ''} (${c.count})`).join(', '))}
      </tbody>
    </table>
  )
}

interface PhotoTabProps {
  projectId: string
  photo: PhotoDetail
  count: number
  sequences: Sequence[]
  range: [number, number] | null
  onChanged: (u?: UndoState) => void
  onError: (m: string) => void
}

function PhotoTab({ projectId, photo, count, sequences, range, onChanged, onError }: PhotoTabProps) {
  const [draft, setDraft] = useState<number | null>(null)
  const [typed, setTyped] = useState('')
  const [rangeValue, setRangeValue] = useState('15')
  useEffect(() => {
    setDraft(null)
    setTyped(photo.heading_final != null ? String(photo.heading_final) : '')
  }, [photo.id, photo.heading_final])
  const seq = sequences.find((s) => s.id === photo.sequence_id)
  const computedWithOffset = photo.heading_auto != null ? (photo.heading_auto + (photo.sequence_offset || 0) + 360) % 360 : null
  const shown = draft ?? photo.heading_final
  const set = (v: number | null) =>
    api.setHeading(projectId, photo.id, v == null ? null : Math.round((((v % 360) + 360) % 360) * 100) / 100).then((r) => onChanged(r.undo), (e) => onError(e.message))
  const rangeOp = (mode: 'offset' | 'set' | 'clear') =>
    range &&
    api.headingRange(projectId, range[0], range[1], mode, Number(rangeValue) || 0).then((r) => onChanged(r.undo), (e) => onError(e.message))

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
      <div className="small-text">
        {seq ? (
          <>
            Séquence <strong>{seq.name}</strong> · photo {photo.rank}/{seq.count}
          </>
        ) : (
          <span className="muted">Non classée</span>
        )}
      </div>

      <h3>Cap</h3>
      <div className="heading-box">
        <HeadingDial value={shown} computed={computedWithOffset} onChange={setDraft} onCommit={(v) => set(v)} />
        <div className="heading-info small-text">
          <div>
            Calculé : {photo.heading_auto != null ? `${photo.heading_auto.toFixed(1)}°` : photo.heading_auto_state === 'uncertain' ? 'incertain (arrêt)' : 'impossible'}
            {photo.sequence_offset ? ` ${photo.sequence_offset > 0 ? '+' : ''}${photo.sequence_offset}° (séquence)` : ''}
          </div>
          <div>
            Final : <strong>{shown != null ? `${shown.toFixed(1)}°` : '—'}</strong>{' '}
            {photo.heading_manual != null && <span className="badge">manuel</span>}
            {photo.heading_stale ? <span className="badge warn-text">à revoir</span> : null}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const v = Number(typed.replace(',', '.'))
              if (typed.trim() !== '' && v >= 0 && v < 360) set(v)
            }}
          >
            <input className="num" type="number" min={0} max={359.99} step={0.01} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Cap en degrés" />
            <button className="small" type="submit">
              OK
            </button>
          </form>
          <div className="row">
            {[-5, -1, 1, 5].map((d) => (
              <button key={d} className="small" disabled={shown == null} onClick={() => shown != null && set(shown + d)}>
                {d > 0 ? `+${d}` : d}°
              </button>
            ))}
          </div>
          {photo.heading_manual != null && (
            <button className="small" onClick={() => set(null)}>
              Revenir au cap calculé
            </button>
          )}
        </div>
      </div>
      {range && (
        <div className="range-heading small-text">
          Plage {range[0] + 1} → {range[1] + 1} :{' '}
          <input className="num" type="number" step="0.5" value={rangeValue} onChange={(e) => setRangeValue(e.target.value)} />°{' '}
          <button className="small" onClick={() => rangeOp('offset')} title="Ajoute la valeur au cap final de chaque photo">
            Décaler
          </button>
          <button className="small" onClick={() => rangeOp('set')} title="Même cap pour toutes les photos">
            Fixer
          </button>
          <button className="small" onClick={() => rangeOp('clear')}>
            Caps calculés
          </button>
        </div>
      )}

      <h3>Informations</h3>
      <table className="summary">
        <tbody>
          <tr>
            <th>Date</th>
            <td>{photo.ts_text ?? '—'}</td>
          </tr>
          <tr>
            <th>GPS</th>
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

type Tab = 'photo' | 'sequences' | 'export' | 'summary'

export default function ProjectView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null)
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [undoState, setUndoState] = useState<UndoState>({ undo: null, redo: null })
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)
  const anchor = useRef<number | null>(null)
  const [tab, setTab] = useState<Tab>('photo')
  const [showImport, setShowImport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  const [panelWidth, setPanelWidth] = useState(400)
  const lastPhotosKey = useRef('')

  const byIdx = photos
  const current = useMemo(() => photos.find((p) => p.id === selected) ?? null, [photos, selected])

  const reloadPhotos = useCallback(async () => setPhotos(await api.photos(projectId)), [projectId])

  const refresh = useCallback(async () => {
    try {
      const p = await api.project(projectId)
      setProject(p)
      const key = `${p.summary.total}-${p.summary.thumbs_done}-${p.summary.thumbs_failed}-${p.summary.gps_jumps}-${p.summary.missing_files}`
      if (key !== lastPhotosKey.current) {
        lastPhotosKey.current = key
        await reloadPhotos()
        const s = await api.sequences(projectId)
        setSequences(s.sequences)
        setUndoState(s.undo)
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [projectId, reloadPhotos])

  useEffect(() => {
    refresh()
  }, [refresh])

  const running = project?.jobs.some((j) => j.state === 'running')
  useEffect(() => {
    if (!running) return
    const t = setInterval(refresh, 1000)
    return () => clearInterval(t)
  }, [running, refresh])

  // After any edit: sequences/undo state from the response, photos reloaded (colours, headings)
  const applyState = useCallback(
    async (s: SeqState & { done?: string }) => {
      setSequences(s.sequences)
      setUndoState(s.undo)
      if (s.done) setNotice(s.done)
      await reloadPhotos()
      api.project(projectId).then(setProject, () => undefined)
    },
    [projectId, reloadPhotos],
  )
  const afterHeadingChange = useCallback(
    async (u?: UndoState) => {
      if (u) setUndoState(u)
      await reloadPhotos()
      const s = await api.sequences(projectId)
      setSequences(s.sequences)
      setUndoState(s.undo)
    },
    [projectId, reloadPhotos],
  )
  const fail = useCallback((m: string) => setError(m), [])

  useEffect(() => {
    if (selected == null) {
      setDetail(null)
      return
    }
    api.photo(projectId, selected).then(setDetail, () => setDetail(null))
  }, [projectId, selected, photos])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(t)
  }, [notice])

  const goIdx = useCallback(
    (idx: number, extend = false) => {
      if (!byIdx.length) return
      const i = Math.max(0, Math.min(byIdx.length - 1, idx))
      setSelected(byIdx[i].id)
      if (extend && anchor.current != null) setRange([Math.min(anchor.current, i), Math.max(anchor.current, i)])
      else anchor.current = i
    },
    [byIdx],
  )

  const undoRedo = useCallback(
    (which: 'undo' | 'redo') => (which === 'undo' ? api.undo(projectId) : api.redo(projectId)).then(applyState, (e) => setError(e.message)),
    [projectId, applyState],
  )

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.closest('input, textarea, select') || showImport) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'z') {
        undoRedo(e.shiftKey ? 'redo' : 'undo')
      } else if (ctrl && e.key.toLowerCase() === 'y') {
        undoRedo('redo')
      } else if (ctrl) {
        return
      } else if (e.key === '?') {
        setShowHelp((v) => !v)
      } else if (!photos.length) {
        return
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = current ? current.idx : -1
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowRight' ? 1 : -1)
        goIdx(i < 0 ? 0 : i + step)
      } else if (e.key === 'Home') goIdx(0)
      else if (e.key === 'End') goIdx(photos.length - 1)
      else if (e.key === 'PageDown' || e.key === 'PageUp') {
        if (!sequences.length) return
        const i = current?.idx ?? -1
        const target =
          e.key === 'PageDown' ? sequences.find((s) => s.start_idx > i) : [...sequences].reverse().find((s) => s.start_idx < i && !(current?.sequence_id === s.id && s.start_idx === i))
        if (target) goIdx(target.start_idx)
      } else if (e.key === 'd' || e.key === 'D') {
        if (!current) return
        const end = range ? Math.max(range[1], current.idx) : current.idx
        setRange([current.idx, end])
        anchor.current = current.idx
      } else if (e.key === 'f' || e.key === 'F') {
        if (!current) return
        const start = range ? Math.min(range[0], current.idx) : anchor.current ?? current.idx
        setRange([Math.min(start, current.idx), Math.max(start, current.idx)])
      } else if (e.key === 's' || e.key === 'S') {
        if (range) api.createSequence(projectId, range[0], range[1]).then((s) => { applyState(s); setRange(null) }, (er) => setError(er.message))
      } else if (e.key === 'c' || e.key === 'C') {
        if (current?.sequence_id != null) api.splitSequence(projectId, current.sequence_id, current.id).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (current?.sequence_id != null) api.removePhotos(projectId, [current.id]).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'Escape') {
        setRange(null)
      } else if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
        if (detail?.heading_final == null) return
        const d = (e.key === ']' || e.key === '}' ? 1 : -1) * (e.shiftKey ? 5 : 1)
        const v = (((detail.heading_final + d) % 360) + 360) % 360
        api.setHeading(projectId, detail.id, Math.round(v * 100) / 100).then((r) => afterHeadingChange(r.undo), (er) => setError(er.message))
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photos, current, range, sequences, detail, projectId, showImport, goIdx, applyState, afterHeadingChange, undoRedo])

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
    const move = (ev: MouseEvent) => setPanelWidth(Math.max(280, Math.min(800, startW - (ev.clientX - startX))))
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
          Importer
        </button>
        <button disabled={!undoState.undo} onClick={() => undoRedo('undo')} title={undoState.undo ? `Annuler : ${undoState.undo} (Ctrl+Z)` : 'Rien à annuler'}>
          ↶ Annuler
        </button>
        <button disabled={!undoState.redo} onClick={() => undoRedo('redo')} title={undoState.redo ? `Rétablir : ${undoState.redo} (Ctrl+Y)` : 'Rien à rétablir'}>
          ↷ Rétablir
        </button>
        <button onClick={() => api.checkFiles(projectId).then(refresh)} title="Signaler les fichiers sources introuvables">
          Vérifier les fichiers
        </button>
        {project.summary.thumbs_failed > 0 && <button onClick={() => api.retryThumbs(projectId).then(refresh)}>Relancer les miniatures</button>}
        <span className="spacer" />
        {notice && <span className="notice small-text">✓ {notice}</span>}
        <button onClick={() => setShowHelp(true)} title="Raccourcis clavier (?)">
          ?
        </button>
        <select value={basemap.id} onChange={(e) => chooseBasemap(e.target.value)} aria-label="Fond de carte">
          {basemaps.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value="__add">+ Ajouter un fond XYZ…</option>
        </select>
      </header>
      {error && (
        <div className="error banner" onClick={() => setError(null)}>
          {error} <span className="muted">(cliquer pour fermer)</span>
        </div>
      )}
      <main className="main" style={{ gridTemplateColumns: `1fr 6px ${panelWidth}px` }}>
        <div className="center">
          <PhotoMap photos={photos} sequences={sequences} basemap={basemap} selectedId={selected} range={range} onSelect={(id, extend) => {
            const p = photos.find((x) => x.id === id)
            if (p) goIdx(p.idx, extend)
          }} />
          <Timeline photos={photos} sequences={sequences} selectedIdx={current?.idx ?? null} range={range} onPick={goIdx} />
        </div>
        <div className="resizer" onMouseDown={startResize} title="Redimensionner" />
        <aside className="side">
          <nav className="tabs" role="tablist">
            {(
              [
                ['photo', 'Photo'],
                ['sequences', `Séquences (${sequences.length})`],
                ['export', 'Export'],
                ['summary', 'Bilan'],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'photo' &&
              (detail ? (
                <PhotoTab projectId={projectId} photo={detail} count={photos.length} sequences={sequences} range={range} onChanged={afterHeadingChange} onError={fail} />
              ) : (
                <p className="muted">{photos.length ? 'Cliquez sur une photo de la carte ou de la timeline, ou utilisez ← →.' : 'Importez un dossier de photos pour commencer.'}</p>
              ))}
            {tab === 'sequences' && (
              <SequencesTab
                projectId={projectId}
                sequences={sequences}
                current={current}
                range={range}
                onState={(s) => {
                  applyState(s)
                  setRange(null)
                }}
                onGo={(idx) => goIdx(idx)}
                onError={fail}
              />
            )}
            {tab === 'export' && <ExportTab projectId={projectId} sequences={sequences} jobs={project.jobs} onStarted={refresh} onError={fail} />}
            {tab === 'summary' && (
              <>
                <Summary p={project} />
                <HeadingSettings
                  key={`${project.settings.heading_min_m}-${project.settings.heading_window_s}`}
                  p={project}
                  onSaved={() => {
                    setNotice('Caps recalculés')
                    lastPhotosKey.current = ''
                    refresh()
                  }}
                  onError={fail}
                />
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
              </>
            )}
          </div>
        </aside>
      </main>
      <JobBar jobs={project.jobs} projectId={projectId} />
      {showImport && <ImportDialog projectId={projectId} onClose={() => setShowImport(false)} onStarted={refresh} />}
      {showHelp && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowHelp(false)}>
          <div className="modal small-modal" role="dialog" aria-label="Raccourcis clavier">
            <h2>Raccourcis clavier</h2>
            <table className="summary">
              <tbody>
                {SHORTCUTS.map(([k, v]) => (
                  <tr key={k}>
                    <th>
                      <kbd>{k}</kbd>
                    </th>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small-text muted">Sur la carte et la timeline : Maj+clic étend la plage. Glisser sur la timeline sélectionne une plage.</p>
            <div className="actions">
              <button onClick={() => setShowHelp(false)}>Fermer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
