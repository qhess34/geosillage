import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, FLAG_LABELS, Job, PhotoDetail, PhotoRow, Project, SeqState, Sequence, UndoState } from './api'
import { Basemap, BUILTIN_BASEMAPS, loadCustomBasemaps, saveCustomBasemaps } from './basemaps'
import ExportTab from './ExportTab'
import { fmtCoord, fmtDistance, fmtDuration, fmtSize, fmtTime } from './format'
import HeadingDial from './HeadingDial'
import ImportDialog from './ImportDialog'
import PhotoMap from './PhotoMap'
import SequencesTab from './SequencesTab'
import SyncTab from './SyncTab'
import { positionAt, Track } from './timesync'
import Timeline from './Timeline'
import Viewer360 from './Viewer360'

const JOB_LABELS: Record<string, string> = {
  import: 'Import',
  thumbnails: 'Miniatures',
  check_files: 'Vérification des fichiers',
  export: 'Export',
}

const POS_LABELS: Record<string, string> = { manual: 'manuelle', offset: 'décalage', along: 'le long du trajet', time: 'synchro temporelle' }

// Great-circle distance (display only)
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

const SHORTCUTS: [string, string][] = [
  ['← / →', 'Photo précédente / suivante (Maj : par 10)'],
  ['Début / Fin', 'Première / dernière photo'],
  ['Page ↑ / Page ↓', 'Séquence précédente / suivante'],
  ['D', 'Début de séquence sur la photo courante (la plage suit ensuite la navigation)'],
  ['F', 'Fin de séquence : crée la séquence du début jusqu\'à la photo courante'],
  ['C', 'Découper ici : coupe la séquence avant la photo courante (photo non classée : crée la séquence autour, puis coupe)'],
  ['X ou Suppr', 'Exclure la photo courante et passer à la suivante (avec une plage : exclure la plage)'],
  ['Maj+X', 'Réintégrer la photo courante'],
  ['Échap', 'Effacer la plage'],
  ['[ / ]', 'Cap de la photo −1° / +1° (Maj : 5°)'],
  ['M', 'Mode positions : glisser le marqueur violet, ou cliquer la carte pour placer une photo sans GPS'],
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
        {row('Exclues', s.excluded, s.excluded > 0)}
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

function SeqButtons({
  current,
  seqStart,
  range,
  onStart,
  onFinish,
  big,
}: {
  current: PhotoRow | null
  seqStart: number | null
  range: [number, number] | null
  onStart: () => void
  onFinish: () => void
  big?: boolean
}) {
  const n = seqStart != null && current ? Math.abs(current.idx - seqStart) + 1 : range ? range[1] - range[0] + 1 : 0
  return (
    <div className={big ? 'seq-buttons big' : 'seq-buttons'}>
      <button disabled={!current} onClick={onStart} title="Début de séquence sur la photo courante (D)" className={seqStart != null ? 'active' : ''}>
        ⏵ Début{seqStart != null ? ` (photo ${seqStart + 1})` : ''}
      </button>
      <button
        className="primary"
        disabled={!current || (seqStart == null && !range)}
        onClick={onFinish}
        title={seqStart != null || range ? 'Créer la séquence jusqu\'à la photo courante (F)' : 'Marquez d\'abord le début (D)'}
      >
        ⏹ Fin{n ? ` — créer (${n} photos)` : ''}
      </button>
    </div>
  )
}

interface PhotoTabProps {
  projectId: string
  photo: PhotoDetail
  count: number
  sequences: Sequence[]
  range: [number, number] | null
  seqButtons: React.ReactNode
  onView: (yawDeg: number) => void
  onChanged: (u?: UndoState) => void
  onError: (m: string) => void
}

function PhotoTab({ projectId, photo, count, sequences, range, seqButtons, onView, onChanged, onError }: PhotoTabProps) {
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
  const [latTyped, setLatTyped] = useState('')
  const [lonTyped, setLonTyped] = useState('')
  const [east, setEast] = useState('0')
  const [north, setNorth] = useState('0')
  const [along, setAlong] = useState('3')
  useEffect(() => {
    const la = photo.lat ?? photo.lat_orig
    const lo = photo.lon ?? photo.lon_orig
    setLatTyped(la != null ? la.toFixed(7) : '')
    setLonTyped(lo != null ? lo.toFixed(7) : '')
  }, [photo.id, photo.lat, photo.lon, photo.lat_orig, photo.lon_orig])
  const setPos = (lat: number | null, lon: number | null) =>
    api.setPosition(projectId, photo.id, lat, lon).then((r) => onChanged(r.undo), (e) => onError(e.message))
  const batch = (mode: 'offset' | 'along' | 'revert') =>
    range &&
    api
      .positionsBatch(projectId, {
        start_idx: range[0],
        end_idx: range[1],
        mode,
        east_m: Number(east) || 0,
        north_m: Number(north) || 0,
        meters: Number(along) || 0,
      })
      .then((r) => onChanged(r.undo), (e) => onError(e.message))

  return (
    <div className="photo-panel">
      {photo.thumb === -1 ? (
        <div className="thumb placeholder">Image illisible</div>
      ) : (
        <Viewer360
          thumbUrl={photo.thumb === 1 ? api.thumbUrl(projectId, photo.id) : api.imageUrl(projectId, photo.id)}
          imageUrl={api.imageUrl(projectId, photo.id)}
          alt={photo.filename}
          height={280}
          yaw={photo.yaw_offset}
          onView={onView}
          fixLabel={range ? `Direction du vélo (plage ${range[0] + 1}→${range[1] + 1})` : 'Fixer la direction du vélo'}
          onFixYaw={(y) =>
            api
              .setYaw(projectId, range ? { start_idx: range[0], end_idx: range[1] } : { photo_ids: [photo.id] }, y)
              .then((r) => onChanged(r.undo), (e) => onError(e.message))
          }
          onResetYaw={() => api.setYaw(projectId, { photo_ids: [photo.id] }, null).then((r) => onChanged(r.undo), (e) => onError(e.message))}
        />
      )}
      <div className="photo-title">
        <strong>{photo.filename}</strong>
        <span className="muted">
          {photo.idx + 1} / {count}
        </span>
      </div>
      {seqButtons}
      {photo.excluded ? (
        <div className="excluded-box small-text">
          Photo exclue (hors séquences, jamais exportée).{' '}
          <button className="small" onClick={() => api.excludePhotos(projectId, { photo_ids: [photo.id] }, false).then(() => onChanged(), (e) => onError(e.message))}>
            Réintégrer (Maj+X)
          </button>
        </div>
      ) : null}
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
          {photo.yaw_offset != null && photo.yaw_offset !== 0 && (
            <div title="Orientation de l'image (caméra sur casque, ou montée à l'envers) : écrite dans XMP-GPano:PoseHeadingDegrees, le JPEG n'est pas modifié">
              Orientation : {photo.yaw_offset > 0 ? '+' : ''}
              {photo.yaw_offset}° par rapport au vélo
            </div>
          )}
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
          <button
            className="small"
            onClick={() => api.rotateYaw(projectId, { start_idx: range[0], end_idx: range[1] }, 180).then((r) => onChanged(r.undo), (e) => onError(e.message))}
            title="Caméra montée à l'envers : tourne les photos de la plage de 180° (XMP, le JPEG n'est pas modifié)"
          >
            ↻ 180°
          </button>
        </div>
      )}

      <h3>Position</h3>
      <div className="small-text position-box">
        <div>
          Originale : <span className="mono">{fmtCoord(photo.lat_orig, photo.lon_orig)}</span>
        </div>
        {photo.pos_method ? (
          <div>
            Corrigée : <span className="mono">{fmtCoord(photo.lat, photo.lon)}</span> <span className="badge">{POS_LABELS[photo.pos_method] ?? photo.pos_method}</span>{' '}
            {photo.lat_orig != null && photo.lon != null && photo.lat != null && photo.lon_orig != null && (
              <span className="muted">({fmtDistance(distanceM(photo.lat_orig, photo.lon_orig, photo.lat, photo.lon))})</span>
            )}
          </div>
        ) : (
          <div className="muted">Pas de correction. Touche M puis glisser le marqueur violet sur la carte.</div>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            const la = Number(latTyped.replace(',', '.'))
            const lo = Number(lonTyped.replace(',', '.'))
            if (latTyped && lonTyped && Number.isFinite(la) && Number.isFinite(lo)) setPos(la, lo)
          }}
        >
          <input className="coord" value={latTyped} onChange={(e) => setLatTyped(e.target.value)} placeholder="latitude" aria-label="Latitude" />
          <input className="coord" value={lonTyped} onChange={(e) => setLonTyped(e.target.value)} placeholder="longitude" aria-label="Longitude" />
          <button className="small" type="submit">
            OK
          </button>
        </form>
        {photo.pos_method && (
          <button className="small" onClick={() => setPos(null, null)}>
            Revenir à la position d'origine
          </button>
        )}
      </div>
      {range && (
        <div className="range-heading small-text">
          <div>
            Positions de la plage {range[0] + 1} → {range[1] + 1} :
          </div>
          <div className="row wrap">
            <label>
              E <input className="num" type="number" step="0.5" value={east} onChange={(e) => setEast(e.target.value)} /> m
            </label>
            <label>
              N <input className="num" type="number" step="0.5" value={north} onChange={(e) => setNorth(e.target.value)} /> m
            </label>
            <button className="small" onClick={() => batch('offset')} title="Déplace toutes les photos de la plage du même vecteur">
              Décaler
            </button>
          </div>
          <div className="row wrap">
            <label>
              <input className="num" type="number" step="0.5" value={along} onChange={(e) => setAlong(e.target.value)} /> m
            </label>
            <button className="small" onClick={() => batch('along')} title="Avance (valeur positive) ou recule chaque photo dans son sens de déplacement">
              Le long du trajet
            </button>
            <button className="small" onClick={() => batch('revert')}>
              Positions d'origine
            </button>
          </div>
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

type Tab = 'photo' | 'sequences' | 'sync' | 'export' | 'summary'

export default function ProjectView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null)
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [undoState, setUndoState] = useState<UndoState>({ undo: null, redo: null })
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)
  // Manual sequence: index of the photo marked "Début"; the range follows the navigation until "Fin"
  const [seqStart, setSeqStart] = useState<number | null>(null)
  const [viewYaw, setViewYaw] = useState(0) // 360° viewer direction relative to the front
  const anchor = useRef<number | null>(null)
  const [tab, setTab] = useState<Tab>('photo')
  const [showImport, setShowImport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [track, setTrack] = useState<Track | null>(null)
  const [syncOffset, setSyncOffset] = useState<number | null>(null)
  const [syncDragged, setSyncDragged] = useState<{ photoId: number; offset: number } | null>(null)
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

  // Time synchronisation: track loaded when the tab opens (and after imports)
  const photoCount = photos.length
  useEffect(() => {
    if (tab !== 'sync') return
    api.track(projectId).then((t) => setTrack(t.runs), (e) => setError(e.message))
  }, [tab, projectId, photoCount])
  const sync = useMemo(() => (tab === 'sync' && track ? { track, offset: syncOffset } : null), [tab, track, syncOffset])
  const onSyncOffset = useCallback(
    (offset: number, final: boolean) => {
      setSyncOffset(offset)
      if (!final || selected == null) return
      // Authoritative value from the backend (same projection, geodesic)
      const p = photos.find((x) => x.id === selected)
      const pos = p && p.ts != null && track ? positionAt(track, p.ts + offset) : null
      setSyncDragged({ photoId: selected, offset })
      if (pos)
        api.syncOffset(projectId, selected, pos[0], pos[1]).then((r) => {
          setSyncOffset(r.offset_s)
          setSyncDragged({ photoId: selected, offset: r.offset_s })
        }, () => undefined)
    },
    [selected, photos, track, projectId],
  )

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
      if (extend && anchor.current != null) {
        setSeqStart(null)
        setRange([Math.min(anchor.current, i), Math.max(anchor.current, i)])
      } else anchor.current = i
    },
    [byIdx],
  )

  const undoRedo = useCallback(
    (which: 'undo' | 'redo') => (which === 'undo' ? api.undo(projectId) : api.redo(projectId)).then(applyState, (e) => setError(e.message)),
    [projectId, applyState],
  )

  const markStart = useCallback(() => {
    if (!current) return
    setSeqStart(current.idx)
    setRange([current.idx, current.idx])
    anchor.current = current.idx
    setNotice(`Début : photo ${current.idx + 1} — naviguez puis « Fin »`)
  }, [current])
  const finishSequence = useCallback(() => {
    // from the marked start (or a range drawn on the timeline) to the current photo
    const r: [number, number] | null =
      seqStart != null && current ? [Math.min(seqStart, current.idx), Math.max(seqStart, current.idx)] : range
    if (!r) {
      setError('Marquez d\'abord le début de la séquence (bouton « Début » ou touche D)')
      return
    }
    api.createSequence(projectId, r[0], r[1]).then((s) => {
      applyState({ ...s, done: `Séquence créée : photos ${r[0] + 1} → ${r[1] + 1}` })
      setRange(null)
      setSeqStart(null)
    }, (er) => setError(er.message))
  }, [seqStart, current, range, projectId, applyState])
  // While a start is marked, the range follows the current photo
  useEffect(() => {
    if (seqStart == null || !current) return
    setRange([Math.min(seqStart, current.idx), Math.max(seqStart, current.idx)])
  }, [seqStart, current])

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
        markStart()
      } else if (e.key === 'f' || e.key === 'F' || e.key === 's' || e.key === 'S') {
        finishSequence()
      } else if (e.key === 'c' || e.key === 'C') {
        if (current) api.cutAt(projectId, current.id).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'X' && e.shiftKey) {
        if (current?.excluded) api.excludePhotos(projectId, { photo_ids: [current.id] }, false).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'x' || e.key === 'Delete') {
        if (range) {
          api.excludePhotos(projectId, { start_idx: range[0], end_idx: range[1] }).then((s) => {
            applyState(s)
            setRange(null)
          }, (er) => setError(er.message))
        } else if (current) {
          // exclude and move on: pressing the key repeatedly removes a series of photos
          if (!current.excluded) api.excludePhotos(projectId, { photo_ids: [current.id] }).then(applyState, (er) => setError(er.message))
          goIdx(current.idx + 1)
        }
      } else if (e.key === 'm' || e.key === 'M') {
        setEditMode((v) => !v)
      } else if (e.key === 'Escape') {
        setSeqStart(null)
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
  }, [photos, current, range, sequences, detail, projectId, showImport, goIdx, applyState, afterHeadingChange, undoRedo, markStart, finishSequence])

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
    const move = (ev: MouseEvent) => setPanelWidth(Math.max(280, Math.min(window.innerWidth * 0.65, startW - (ev.clientX - startX))))
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
        <button
          disabled={!current}
          onClick={() => current && api.cutAt(projectId, current.id).then(applyState, (er) => setError(er.message))}
          title="Découper la sortie avant la photo courante (C)"
        >
          ✂ Couper ici
        </button>
        <SeqButtons current={current} seqStart={seqStart} range={range} onStart={markStart} onFinish={finishSequence} />
        <button
          className={editMode ? 'primary' : ''}
          aria-pressed={editMode}
          onClick={() => setEditMode(!editMode)}
          title="Mode positions (M) : glisser le marqueur de la photo courante pour corriger sa position"
        >
          ✥ Positions
        </button>
        <span className="spacer" />
        {notice && <div className="toast small-text">✓ {notice}</div>}
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
          <PhotoMap
            photos={photos}
            sequences={sequences}
            basemap={basemap}
            selectedId={selected}
            range={range}
            editMode={editMode}
            sync={sync}
            viewAzimuth={tab === 'photo' && current?.heading != null ? (((current.heading + viewYaw) % 360) + 360) % 360 : null}
            onSyncOffset={onSyncOffset}
            onSelect={(id, extend) => {
              const p = photos.find((x) => x.id === id)
              if (p) goIdx(p.idx, extend)
            }}
            onMove={(id, lat, lon) =>
              api.setPosition(projectId, id, lat, lon).then((r) => afterHeadingChange(r.undo), (er) => setError(er.message))
            }
          />
          <Timeline photos={photos} sequences={sequences} selectedIdx={current?.idx ?? null} range={range} onPick={goIdx} />
        </div>
        <div className="resizer" onMouseDown={startResize} title="Redimensionner" />
        <aside className="side">
          <nav className="tabs" role="tablist">
            {(
              [
                ['photo', 'Photo'],
                ['sequences', `Séquences (${sequences.length})`],
                ['sync', 'Synchro'],
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
                <PhotoTab
                  projectId={projectId}
                  photo={detail}
                  count={photos.length}
                  sequences={sequences}
                  range={range}
                  seqButtons={<SeqButtons current={current} seqStart={seqStart} range={range} onStart={markStart} onFinish={finishSequence} big />}
                  onView={setViewYaw}
                  onChanged={afterHeadingChange}
                  onError={fail}
                />
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
                onRefresh={() => {
                  setNotice('Photos tournées de 180°')
                  afterHeadingChange()
                }}
                onError={fail}
              />
            )}
            {tab === 'sync' && (
              <SyncTab
                projectId={projectId}
                photo={detail}
                photos={photos}
                sequences={sequences}
                range={range}
                offset={syncOffset}
                dragged={syncDragged}
                onOffset={setSyncOffset}
                onGo={(idx) => goIdx(idx)}
                onApplied={() => {
                  afterHeadingChange()
                  api.project(projectId).then(setProject, () => undefined)
                }}
                onNotice={setNotice}
                onError={fail}
              />
            )}
            {tab === 'export' && (
              <ExportTab
                projectId={projectId}
                sequences={sequences}
                jobs={project.jobs}
                sources={project.sources}
                excludedPhotos={project.summary.excluded}
                onStarted={refresh}
                onError={fail}
              />
            )}
            {tab === 'summary' && (
              <>
                <Summary p={project} />
                <div className="row wrap">
                  <button className="small" onClick={() => api.checkFiles(projectId).then(refresh)} title="Signaler les fichiers sources introuvables">
                    Vérifier les fichiers
                  </button>
                  {project.summary.thumbs_failed > 0 && (
                    <button className="small" onClick={() => api.retryThumbs(projectId).then(refresh)}>
                      Relancer les miniatures en échec
                    </button>
                  )}
                </div>
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
