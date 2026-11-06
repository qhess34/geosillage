import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, FLAG_LABELS, FLAGS, Job, PhotoDetail, PhotoRow, Project, QualityIssue, SeqState, Sequence, UndoState } from './api'
import { BUILTIN_BASEMAPS } from './basemaps'
import { useCustomBasemaps } from './useCustomBasemaps'
import SettingsDialog from './SettingsDialog'
import ExportTab from './ExportTab'
import { fmtCoord, fmtDistance, fmtDuration, fmtSize, fmtTime } from './format'
import HeadingDial from './HeadingDial'
import ImportDialog from './ImportDialog'
import PhotoMap from './PhotoMap'
import SendTab from './SendTab'
import StepBar from './StepBar'
import IssuesPanel from './IssuesPanel'
import CheckCard, { CheckAction } from './CheckCard'
import { canInterpolate, computeIssues, Issue, ISSUE_TEXT, issueDetail, IssueStep, sameIssue, STEP_KINDS } from './issues'
import StopCompare from './StopCompare'
import MapLegend from './MapLegend'
import { AddBasemap, Confirm, ValueDialog } from './Dialogs'
import SequencesTab from './SequencesTab'
import SyncTab from './SyncTab'
import { positionAt, Track } from './timesync'
import { loadOverlay, OverlaySettings, saveOverlay } from './panoramaxLayer'
import Timeline from './Timeline'
import Viewer360 from './Viewer360'
import ContextMenu, { MenuItem } from './ContextMenu'
import OsmSnapPanel, { SnapPreview, SnapScope } from './OsmSnapPanel'
import YawRotate from './YawRotate'
import { CAP_HELP, CapOrientationDiagram, ORIENTATION_HELP } from './CapOrientation'

const JOB_LABELS: Record<string, string> = {
  import: 'Import',
  thumbnails: 'Miniatures',
  check_files: 'Vérification des fichiers',
  export: 'Export',
  publish: 'Publication Panoramax',
  publish_update: 'Corrections sur Panoramax',
}

const POS_LABELS: Record<string, string> = {
  manual: 'manuelle',
  offset: 'décalage',
  along: 'le long du trajet',
  time: 'synchro temporelle',
  interp: 'interpolée',
  osm: 'recalée sur OSM',
}

// Great-circle distance (display only)
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

const SHORTCUTS: [string, string][] = [
  ['← / →', 'Photo précédente / suivante (Maj : par 10) ; les photos exclues sont sautées (sauf case « Exclues » cochée)'],
  ['Début / Fin', 'Première / dernière photo'],
  ['Page ↑ / Page ↓', 'Séquence précédente / suivante'],
  ['D', 'Début de séquence sur la photo courante (la plage suit ensuite la navigation) ; fenêtre de recalage OSM ouverte : début des photos à recaler'],
  ['F', 'Fin de séquence : crée la séquence du début jusqu\'à la photo courante ; la photo suivante devient le début de la séquence suivante (Échap pour annuler) ; fenêtre de recalage OSM ouverte : fin des photos à recaler'],
  ['C', 'Découper ici : coupe la séquence avant la photo courante (photo non classée : crée la séquence autour, puis coupe)'],
  ['X ou Suppr', 'Exclure la photo courante et passer à la suivante (exclure la photo de début déplace le début à la suivante ; plage tracée sur la timeline : exclure la plage, après confirmation ; Ctrl+Z annule)'],
  ['Maj+X', 'Réintégrer la photo courante'],
  ['Échap', 'Effacer la plage'],
  ['[ / ]', 'Cap de la photo −1° / +1° (Maj : 5°)'],
  ['N / Maj+N', 'Point suivant / précédent à vérifier : arrêt, grand écart, précision GPS, cap, saut GPS, photo sans position, photos non classées (les photos concernées sont sélectionnées)'],
  ['M', 'Mode positions : glisser le marqueur violet, ou cliquer la carte pour placer une photo sans GPS'],
  ['Ctrl+Z / Ctrl+Y', 'Annuler / rétablir'],
  ['?', 'Cette aide'],
]

// Whole ride: offset of the computed headings and camera orientation (not tied to the sequences, which are only a
// logical cut); series of photos: context menu or range tools of the Photo tab
function RideHeadings({ projectId, onDone, onError }: { projectId: string; onDone: (u?: UndoState) => void; onError: (m: string) => void }) {
  const [value, setValue] = useState('0')
  return (
    <div className="small-text ride-headings">
      <h3>Cap et orientation de toute la sortie</h3>
      <p className="muted">
        Pour une série de photos : sélectionnez-la (timeline, Maj+clic) puis clic droit, ou les outils de la plage de l'onglet Photo.
      </p>
      <div className="form-row">
        <span title={`${CAP_HELP} Le décalage s'ajoute aux caps calculés de toutes les photos (il remplace les décalages déjà posés ; 0 les retire) ; les caps manuels ne changent pas.`}>
          Décalage du cap
        </span>
        <span>
          <input className="num" type="number" step="0.5" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Décalage du cap (°)" />°
          <button className="small" onClick={() => api.headingOffset(projectId, { all: true }, Number(value) || 0).then((r) => onDone(r.undo), (e) => onError(e.message))}>
            Appliquer à toute la sortie
          </button>
        </span>
      </div>
      <div className="form-row">
        <span title={`${ORIENTATION_HELP} L'angle s'ajoute à l'orientation de chaque photo (180 : caméra à l'envers).`}>Orientation de la caméra</span>
        <YawRotate projectId={projectId} target={{ all: true }} what="toutes les photos du projet" onDone={onDone} onError={onError} />
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

// Small displacements (local flat approximation, enough for a few hundred meters)
const M_PER_DEG = 111320
function metersBetween(lat0: number, lon0: number, lat1: number, lon1: number): { east: number; north: number } {
  return { north: (lat1 - lat0) * M_PER_DEG, east: (lon1 - lon0) * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180) }
}
function shifted(lat: number, lon: number, east: number, north: number): { lat: number; lon: number } {
  return { lat: lat + north / M_PER_DEG, lon: lon + east / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)) }
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
  const buttons = (
    <>
      <button disabled={!current} onClick={onStart} title="Début de séquence sur la photo courante (D)" className={seqStart != null ? 'active' : ''}>
        ⏵ Début{seqStart != null && big ? ` (photo ${seqStart + 1})` : ''}
      </button>
      <button
        className="primary"
        disabled={!current || (seqStart == null && !range)}
        onClick={onFinish}
        title={seqStart != null || range ? 'Créer la séquence jusqu\'à la photo courante (F)' : 'Marquez d\'abord le début (D)'}
      >
        ⏹ Fin{n ? (big ? ` — ${n} photos` : ` (${n})`) : ''}
      </button>
    </>
  )
  return big ? <div className="seq-buttons big">{buttons}</div> : buttons
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
  const computedWithOffset = photo.heading_auto != null ? (photo.heading_auto + (photo.heading_offset || 0) + 360) % 360 : null
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
          pitch={photo.pitch_orig}
          roll={photo.roll_orig}
          onView={onView}
          fixLabel={range ? `Sens de déplacement (plage ${range[0] + 1}→${range[1] + 1})` : 'Fixer le sens de déplacement'}
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

      <h3 title={CAP_HELP}>Cap — sens de déplacement</h3>
      <p className="small-text muted section-help">Direction dans laquelle on avance, depuis le nord (flèches de la carte et de Panoramax).</p>
      <div className="heading-box">
        <HeadingDial value={shown} computed={computedWithOffset} onChange={setDraft} onCommit={(v) => set(v)} />
        <div className="heading-info small-text">
          <div>
            Calculé : {photo.heading_auto != null ? `${photo.heading_auto.toFixed(1)}°${photo.heading_auto_state === 'stop' ? ' (à l\'arrêt : direction d\'arrivée ou de départ)' : ''}` : photo.heading_auto_state === 'uncertain' ? 'incertain (la caméra ne bouge pas)' : 'impossible'}
            {photo.heading_offset ? ` ${photo.heading_offset > 0 ? '+' : ''}${photo.heading_offset}° (décalage)` : ''}
          </div>
          <div>
            Final : <strong>{shown != null ? `${shown.toFixed(1)}°` : '—'}</strong>{' '}
            {photo.heading_manual != null &&
              (photo.path.startsWith('pnx:') && photo.heading_manual === photo.heading_exif ? (
                <span className="badge" title="Cap de la photo sur Panoramax (point de départ, envoyé seulement s'il change)">Panoramax</span>
              ) : (
                <span className="badge">manuel</span>
              ))}
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
          <div className="btn-group">
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
      <h3 title={ORIENTATION_HELP}>Orientation de la caméra</h3>
      <p className="small-text muted section-help">Où regarde le centre de l'image, par rapport au sens de déplacement (casque, caméra mal montée). Ne change pas le cap.</p>
      <div className="orientation-box small-text">
        <CapOrientationDiagram heading={shown} yaw={photo.yaw_offset} />
        <div>
          <div>
            {photo.yaw_offset ? (
              <>
                Centre de l'image à <strong>{photo.yaw_offset > 0 ? '+' : ''}{photo.yaw_offset}°</strong> du sens de déplacement
                {Math.abs(photo.yaw_offset) >= 170 ? ' (caméra à l\'envers)' : photo.yaw_offset > 0 ? ' (vers la droite)' : ' (vers la gauche)'}
              </>
            ) : (
              <>Centre de l'image <strong>dans le sens de déplacement</strong> (0°)</>
            )}
          </div>
          <div className="muted">
            <span className="cap-key blue" /> cap · <span className="cap-key orange" /> centre de l'image
          </div>
          <div className="muted">Pour la corriger : tournez la vue vers l'avant puis « 🧭 Fixer le sens de déplacement » dans la visionneuse.</div>
          {photo.yaw_offset ? (
            <button className="small" onClick={() => api.setYaw(projectId, { photo_ids: [photo.id] }, null).then((r) => onChanged(r.undo), (e) => onError(e.message))}>
              Remettre à 0°
            </button>
          ) : null}
        </div>
      </div>
      {range && (
        <section className="range-card small-text">
          <header>
            Plage {range[0] + 1} → {range[1] + 1} · {range[1] - range[0] + 1} photos
          </header>
          <div className="form-row">
            <span title={CAP_HELP}>Cap</span>
            <span>
              <input className="num" type="number" step="0.5" value={rangeValue} onChange={(e) => setRangeValue(e.target.value)} aria-label="Angle (°)" />°
              <span className="btn-group">
                <button
                  className="small"
                  onClick={() =>
                    api.headingOffset(projectId, { start_idx: range[0], end_idx: range[1] }, Number(rangeValue) || 0).then((r) => onChanged(r.undo), (e) => onError(e.message))
                  }
                  title="Décalage des caps calculés des photos de la plage (remplace le décalage précédent ; 0 le retire ; les caps manuels ne changent pas)"
                >
                  Décaler
                </button>
                <button className="small" onClick={() => rangeOp('set')} title="Même cap pour toutes les photos">
                  Fixer
                </button>
              </span>
              <button className="small" onClick={() => rangeOp('clear')} title="Caps calculés depuis la trace (les caps manuels de la plage sont oubliés)">
                Caps calculés
              </button>
            </span>
          </div>
          <div className="form-row">
            <span title={ORIENTATION_HELP}>Orientation</span>
            <YawRotate projectId={projectId} target={{ start_idx: range[0], end_idx: range[1] }} what="les photos de la plage" onDone={(u) => onChanged(u)} onError={onError} />
          </div>
        </section>
      )}

      <h3>Position</h3>
      <div className="small-text position-box">
        {photo.lat == null && (photo.lat_orig == null || (photo.flags & FLAGS.INVALID_COORD) !== 0) && (
          <div className="warn-text">
            Photo sans position : elle a été prise entre les deux photos entourées en rouge sur la carte. Touche M puis
            cliquez sur la carte pour la placer, ou{' '}
            <button
              className="link"
              onClick={() =>
                api.missingPositions(projectId).then((runs) => {
                  const run = runs.find((r) => r.ids.includes(photo.id))
                  if (!run) return
                  return api.positionsBatch(projectId, { photo_ids: run.ids, mode: 'interpolate' }).then((r) => {
                    if (!r.changed) onError('Impossible d\'interpoler : pas de photo positionnée avant et après')
                    onChanged(r.undo)
                  })
                }).catch((e) => onError(e.message))
              }
            >
              interpoler ce trou
            </button>{' '}
            entre la photo d'avant et celle d'après.
          </div>
        )}
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
        <div className="row wrap">
          {photo.pos_method && (
            <button className="small" onClick={() => setPos(null, null)}>
              Revenir à la position d'origine
            </button>
          )}
        </div>
      </div>
      {range && (
        <section className="range-card small-text">
          <header>
            Positions de la plage {range[0] + 1} → {range[1] + 1}
          </header>
          <div className="form-row">
            <span>Décaler</span>
            <span>
              E <input className="num" type="number" step="0.5" value={east} onChange={(e) => setEast(e.target.value)} aria-label="Est (m)" /> m · N{' '}
              <input className="num" type="number" step="0.5" value={north} onChange={(e) => setNorth(e.target.value)} aria-label="Nord (m)" /> m
              <button className="small" onClick={() => batch('offset')} title="Déplace toutes les photos de la plage du même vecteur">
                Décaler
              </button>
            </span>
          </div>
          <div className="form-row">
            <span>Le long du trajet</span>
            <span>
              <input className="num" type="number" step="0.5" value={along} onChange={(e) => setAlong(e.target.value)} aria-label="Distance (m)" /> m
              <button className="small" onClick={() => batch('along')} title="Avance (valeur positive) ou recule chaque photo dans son sens de déplacement">
                Avancer / reculer
              </button>
            </span>
          </div>
          <div className="form-row">
            <span />
            <span>
              <button className="small" onClick={() => batch('revert')}>
                Revenir aux positions d'origine
              </button>
            </span>
          </div>
        </section>
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

const fmtLeft = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`)
const JOB_STATES: Record<Job['state'], string> = { done: 'terminée', error: 'erreur', cancelled: 'annulée', interrupted: 'interrompue', running: 'en cours' }

// Status bar: running jobs (progress, time left from the speed seen here), last job; a system notification when a
// long job ends while the window is in the background (if the user allowed it)
function JobBar({ jobs, projectId, projectName }: { jobs: Job[]; projectId: string; projectName: string }) {
  const running = jobs.filter((j) => j.state === 'running')
  const last = jobs[0]
  const seen = useRef(new Map<string, { t: number; done: number }>()) // first observation of each job
  const wasRunning = useRef(new Set<string>())
  const canNotify = typeof Notification !== 'undefined'
  const [perm, setPerm] = useState(canNotify ? Notification.permission : 'denied')
  useEffect(() => {
    for (const j of jobs) {
      if (j.state === 'running') {
        if (!seen.current.has(j.id)) seen.current.set(j.id, { t: Date.now(), done: j.done })
        wasRunning.current.add(j.id)
      } else if (wasRunning.current.has(j.id)) {
        wasRunning.current.delete(j.id)
        const long = Date.now() - (seen.current.get(j.id)?.t ?? Date.now()) > 10000
        if (canNotify && Notification.permission === 'granted' && long && document.hidden)
          new Notification(`${JOB_LABELS[j.kind] ?? j.kind} ${JOB_STATES[j.state]}`, { body: `${projectName}${j.message ? ` — ${j.message}` : ''}` })
      }
    }
  }, [jobs, projectName, canNotify])
  const left = (j: Job) => {
    const s = seen.current.get(j.id)
    if (!s || !j.total || j.done <= s.done) return null
    const elapsed = (Date.now() - s.t) / 1000
    if (elapsed < 3) return null
    return ((j.total - j.done) * elapsed) / (j.done - s.done)
  }
  return (
    <footer className="statusbar">
      {running.length ? (
        running.map((j) => {
          const eta = left(j)
          return (
            <span key={j.id} className="job">
              {JOB_LABELS[j.kind] ?? j.kind} : {j.message ?? ''} {j.total ? `${j.done}/${j.total}` : ''}
              {j.total > 0 && <progress value={j.done} max={j.total} />}
              {eta != null && <span className="muted">≈ {fmtLeft(eta)} restantes</span>}
              <button className="small" onClick={() => api.cancelJob(projectId, j.id)}>
                Annuler
              </button>
            </span>
          )
        })
      ) : last ? (
        <span className={last.state === 'error' ? 'error' : 'muted'}>
          Dernière tâche : {JOB_LABELS[last.kind] ?? last.kind} — {JOB_STATES[last.state]}
          {last.message ? ` (${last.message})` : ''}
        </span>
      ) : (
        <span className="muted">Prêt</span>
      )}
      {canNotify && perm === 'default' && (
        <button
          className="link small-text"
          title="Notification du système quand un export, une publication ou un import se termine pendant que vous êtes dans une autre fenêtre"
          onClick={() => Notification.requestPermission().then(setPerm)}
        >
          🔔 Me prévenir à la fin des tâches
        </button>
      )}
    </footer>
  )
}

type Tab = 'photo' | 'sequences' | 'sync' | 'export' | 'send' | 'summary'

export default function ProjectView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null)
  const isPnx = project?.kind === 'panoramax' // sequences already published: corrections only, no cut, no export
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [quality, setQuality] = useState<QualityIssue[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [undoState, setUndoState] = useState<UndoState>({ undo: null, redo: null })
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)
  // Manual sequence: index of the photo marked "Début"; the range follows the navigation until "Fin"
  const [seqStart, setSeqStart] = useState<number | null>(null)
  const [viewYaw, setViewYaw] = useState(0) // 360° viewer direction relative to the front
  const [overlay, setOverlayState] = useState<OverlaySettings>(loadOverlay)
  // "Suivre" (default): the map keeps the current photo in its centre while browsing
  const [follow, setFollowState] = useState(() => {
    try {
      return localStorage.getItem('pss-follow') !== '0' // on by default
    } catch {
      return true
    }
  })
  const setFollow = (v: boolean) => {
    setFollowState(v)
    try {
      localStorage.setItem('pss-follow', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  // Excluded photos: hidden on the map and skipped by ← → unless shown
  const [showExcluded, setShowExcludedState] = useState(() => {
    try {
      return localStorage.getItem('pss-show-excluded') === '1'
    } catch {
      return false
    }
  })
  const setShowExcluded = (v: boolean) => {
    setShowExcludedState(v)
    try {
      localStorage.setItem('pss-show-excluded', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  // Positions mode: → carries the current photo's correction (offset from its original position) to the next photo
  const [carryPos, setCarryPosState] = useState(() => {
    try {
      return localStorage.getItem('pss-carry-position') !== '0' // on by default
    } catch {
      return true
    }
  })
  const setCarryPos = (v: boolean) => {
    setCarryPosState(v)
    try {
      localStorage.setItem('pss-carry-position', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  const mapPhotos = useMemo(() => (showExcluded ? photos : photos.filter((p) => !p.excluded)), [photos, showExcluded])
  const [centerTick, setCenterTick] = useState(0)
  // OSM snapping of a range: panel shown above the photo tab, preview on the map
  const [snapOpen, setSnapOpen] = useState<{ scope: SnapScope; sequenceId: number | null; bounds?: [number, number] } | null>(null)
  // context menu (right click) on the map, the timeline or a sequence
  const [ctx, setCtx] = useState<{ x: number; y: number; kind: 'photos' | 'sequence'; range?: [number, number]; sequenceId?: number | null } | null>(null)
  const [snapPreview, setSnapPreview] = useState<SnapPreview | null>(null)
  const [snapHighlight, setSnapHighlight] = useState<[number, number] | null>(null) // photos the snapping panel works on
  const setOverlay = (o: OverlaySettings) => {
    setOverlayState(o)
    saveOverlay(o)
  }
  const anchor = useRef<number | null>(null)
  // Reopening a project: back to the same photo, tab (and timeline zoom, see Timeline) as when it was left
  const viewKey = `pss-view-${projectId}`
  const savedView = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(viewKey) || '{}') as { photo?: number; tab?: Tab }
    } catch {
      return {}
    }
  }, [viewKey])
  const [tab, setTab] = useState<Tab>(savedView.tab ?? 'photo')
  const [showImport, setShowImport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [confirmExclude, setConfirmExclude] = useState<{ range: [number, number]; n: number } | null>(null)
  const [addingBasemap, setAddingBasemap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // heading offset / orientation of a series of photos (context menu)
  const [valueDlg, setValueDlg] = useState<{ kind: 'offset' | 'yaw'; range: [number, number] } | null>(null)
  const [issuesStep, setIssuesStep] = useState<IssueStep | null>(null) // list of things to fix of a step (floating window)
  const closeIssues = useCallback(() => setIssuesStep(null), [])
  const [confirmInterp, setConfirmInterp] = useState<number[] | null>(null) // photos to place between their neighbours
  const [stopCompare, setStopCompare] = useState<[number, number] | null>(null) // photos of a stop side by side
  const [editMode, setEditMode] = useState(false)
  const [track, setTrack] = useState<Track | null>(null)
  const [syncOffset, setSyncOffset] = useState<number | null>(null)
  const [syncDragged, setSyncDragged] = useState<{ photoId: number; offset: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { custom, add: addBasemap, remove: removeBasemap } = useCustomBasemaps()
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
  const goIdxRef = useRef<(idx: number) => void>(() => undefined)
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !photos.length) return
    restored.current = true
    const p = photos.find((x) => x.id === savedView.photo)
    if (p) {
      setSelected(p.id)
      anchor.current = p.idx
    }
  }, [photos, savedView])
  useEffect(() => {
    if (!restored.current) return
    try {
      localStorage.setItem(viewKey, JSON.stringify({ photo: selected ?? undefined, tab }))
    } catch {
      /* ignore */
    }
  }, [viewKey, selected, tab])
  // a Panoramax project has no Export tab, a ride has no separate Envoi tab (publication is in « Export et envoi »)
  useEffect(() => {
    if (isPnx && tab === 'export') setTab('send')
    if (project && !isPnx && tab === 'send') setTab('export')
  }, [project, isPnx, tab])
  const current = useMemo(() => photos.find((p) => p.id === selected) ?? null, [photos, selected])

  // points to check, recomputed whenever the photos change (positions, exclusions, headings)
  useEffect(() => {
    if (photos.length) api.quality(projectId).then(setQuality, () => undefined)
    else setQuality([])
  }, [projectId, photos])
  const reloadPhotos = useCallback(async () => setPhotos(await api.photos(projectId)), [projectId])
  // Everything to check, in the order of the ride (N / Shift+N, step bar, Bilan, card of the Photo tab)
  const checkPoints = useMemo(() => computeIssues(quality, photos, isPnx), [quality, photos, isPnx])
  // the same, per step of the step bar (list of things to fix of a step)
  const issuesByStep = useMemo(() => {
    const by = (st: IssueStep) => checkPoints.filter((c) => STEP_KINDS[st].includes(c.kind))
    return { dups: by('dups'), gps: by('gps'), seq: by('seq') }
  }, [checkPoints])
  // The issue being corrected (card on top of the Photo tab), as reached; looked up again in the list at each
  // render: gone = fixed
  const [focusPoint, setFocusPoint] = useState<Issue | null>(null)
  const focusLive = focusPoint ? checkPoints.find((c) => sameIssue(c, focusPoint)) ?? null : null
  const focusOn = useCallback(
    (c: Issue) => {
      goIdxRef.current(c.start)
      setSeqStart(null)
      setRange(c.end > c.start ? [c.start, c.end] : null)
      setFocusPoint(c)
      setTab('photo')
      setCenterTick((t) => t + 1) // the map shows the photo, even when it does not follow the navigation
    },
    [],
  )

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
  // When a job ends (export…), the sequences' export state may have changed. Keyed on the finished jobs, so that a
  // job that ends before the first poll (a short re-export) is not missed.
  const finishedJobs = (project?.jobs ?? []).filter((j) => j.state !== 'running').map((j) => j.id).join(',')
  const lastFinished = useRef<string | null>(null)
  useEffect(() => {
    if (!project) return
    if (lastFinished.current != null && lastFinished.current !== finishedJobs)
      api.sequences(projectId).then((s) => {
        setSequences(s.sequences)
        setUndoState(s.undo)
      }, () => undefined)
    lastFinished.current = finishedJobs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedJobs, projectId])
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
  // photos the offset would move (scope of the Synchro tab): only they are previewed on the map
  const [syncIds, setSyncIds] = useState<Set<number> | null>(null)
  const sync = useMemo(() => (tab === 'sync' && track ? { track, offset: syncOffset, ids: syncIds } : null), [tab, track, syncOffset, syncIds])
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
  goIdxRef.current = goIdx

  // Last position correction made by hand (east / north m), and the photo that holds it now (moved by hand, or
  // carried to with →) with its expected position: the rows may not be reloaded yet when → is pressed right away
  const lastCarry = useRef<{ id: number; east: number; north: number; lat: number; lon: number } | null>(null)
  const undoRedo = useCallback(
    (which: 'undo' | 'redo') => {
      lastCarry.current = null
      return (which === 'undo' ? api.undo(projectId) : api.redo(projectId)).then(applyState, (e) => setError(e.message))
    },
    [projectId, applyState],
  )

  const markStart = useCallback(() => {
    if (!current) return
    setSeqStart(current.idx)
    setRange([current.idx, current.idx])
    anchor.current = current.idx
    setNotice(`Début : photo ${current.idx + 1} — naviguez puis « Fin »`)
  }, [current])
  // Index reached by moving `count` photos from idx in direction dir, skipping excluded photos unless shown
  const stepIdx = useCallback(
    (idx: number, dir: 1 | -1, count = 1) => {
      if (showExcluded) return idx + dir * count
      let i = idx
      let last = idx
      for (let left = count; left > 0; ) {
        i += dir
        if (i < 0 || i >= photos.length) break
        if (!photos[i].excluded) {
          last = i
          left--
        }
      }
      return last
    },
    [photos, showExcluded],
  )
  // First photo after idx that is not excluded
  const nextKept = useCallback((idx: number) => photos.slice(idx + 1).find((p) => !p.excluded) ?? null, [photos])
  const finishSequence = useCallback(() => {
    // from the marked start (or a range drawn on the timeline) to the current photo
    const r: [number, number] | null =
      seqStart != null && current ? [Math.min(seqStart, current.idx), Math.max(seqStart, current.idx)] : range
    if (!r) {
      setError('Marquez d\'abord le début de la séquence (bouton « Début » ou touche D)')
      return
    }
    api.createSequence(projectId, r[0], r[1]).then((s) => {
      // Chain: the next photo not excluded becomes the start of the next sequence (unless it already belongs to one)
      const next = nextKept(r[1])
      const chain = next != null && next.sequence_id == null
      applyState({
        ...s,
        done: `Séquence créée : photos ${r[0] + 1} → ${r[1] + 1}` + (chain ? ` · début suivant : photo ${next!.idx + 1}` : ''),
      })
      if (chain) {
        setSeqStart(next.idx)
        setRange([next.idx, next.idx])
        anchor.current = next.idx
        setSelected(next.id)
      } else {
        setRange(null)
        setSeqStart(null)
      }
    }, (er) => setError(er.message))
  }, [seqStart, current, range, projectId, applyState, nextKept])
  // While a start is marked, the range follows the current photo
  useEffect(() => {
    if (seqStart == null || !current) return
    setRange([Math.min(seqStart, current.idx), Math.max(seqStart, current.idx)])
  }, [seqStart, current])

  // Same correction applied to `to`: the shift last made by hand (drop position minus position before the drag),
  // carried along the → presses; photos corrected by hand are never moved
  const carryCorrection = useCallback(
    (from: PhotoRow, to: PhotoRow | undefined) => {
      const c = lastCarry.current
      if (!c || c.id !== from.id || !to || to.pos_method === 'manual' || to.lat == null || to.lon == null) return
      const { east, north } = c
      if (Math.hypot(east, north) < 0.05 || Math.abs(east) > 1000 || Math.abs(north) > 1000) return
      const r2 = (v: number) => Math.round(v * 100) / 100
      lastCarry.current = { id: to.id, east, north, ...shifted(to.lat, to.lon, east, north) }
      api.positionsBatch(projectId, { start_idx: to.idx, end_idx: to.idx, mode: 'offset', east_m: r2(east), north_m: r2(north) }).then((r) => {
        afterHeadingChange(r.undo)
        setNotice(`Correction reportée sur la photo ${to.idx + 1} : ${Math.round(Math.hypot(east, north) * 10) / 10} m`)
      }, (er) => setError(er.message))
    },
    [projectId, afterHeadingChange],
  )

  const excludeRange = useCallback(
    (r: [number, number], n: number) =>
      api.excludePhotos(projectId, { start_idx: r[0], end_idx: r[1] }).then((s) => {
        applyState({ ...s, done: `${n} photo(s) exclue(s) — Ctrl+Z pour annuler` })
        setRange(null)
      }, (er) => setError(er.message)),
    [projectId, applyState],
  )

  useEffect(() => {
    if (focusPoint && (!current || current.idx < focusPoint.start || current.idx > focusPoint.end)) setFocusPoint(null)
  }, [current, focusPoint])

  // « Ignorer » headings to check: the manual heading is right (computed one wrong, GPS lost); points recomputed
  const ignoreHeadings = useCallback(
    (ids: number[]) =>
      api.ignoreHeadings(projectId, ids).then((res) => {
        setQuality(res.issues)
        afterHeadingChange(res.undo)
        setNotice('Cap gardé : il n\'est plus signalé tant qu\'il ne change pas — Ctrl+Z pour annuler')
      }, (er) => setError(er.message)),
    [projectId, afterHeadingChange],
  )
  // Actions of the card of the Photo tab on the photos of the issue being corrected (exclusion: confirmed first)
  const fixIssue = useCallback(
    (what: CheckAction) => {
      if (!focusPoint) return
      const r: [number, number] = [focusPoint.start, focusPoint.end]
      const kept = photos.slice(r[0], r[1] + 1).filter((p) => !p.excluded)
      if (what === 'exclude') return setConfirmExclude({ range: r, n: kept.length })
      if (what === 'ignore-headings') return ignoreHeadings(kept.map((p) => p.id))
      if (what === 'interpolate')
        return api.positionsBatch(projectId, { photo_ids: kept.map((p) => p.id), mode: 'interpolate' }).then((res) => {
          if (!res.changed) setError('Impossible d\'interpoler : pas de photo positionnée avant et après')
          else setNotice(`${res.changed} photo(s) placée(s) entre les voisines — Ctrl+Z pour annuler`)
          afterHeadingChange(res.undo)
        }, (er) => setError(er.message))
      if (what === 'clear-headings')
        return api.headingRange(projectId, r[0], r[1], 'clear').then((res) => {
          afterHeadingChange(res.undo)
          setNotice('Cap calculé rétabli — Ctrl+Z pour annuler')
        }, (er) => setError(er.message))
      return api
        .createSequence(projectId, r[0], r[1])
        .then((st) => applyState({ ...st, done: `Séquence créée : photos ${r[0] + 1} → ${r[1] + 1}` }), (er) => setError(er.message))
    },
    [focusPoint, photos, projectId, afterHeadingChange, applyState, ignoreHeadings],
  )
  // « Interpoler tous les trous possibles » (list of things to fix): every hole with a positioned photo before and
  // after; a bulk action, confirmed first
  const askInterpolateAll = useCallback(
    () =>
      api.missingPositions(projectId).then((runs) => {
        const ids = runs.filter((r) => r.prev && r.next).flatMap((r) => r.ids)
        if (ids.length) setConfirmInterp(ids)
        else setNotice('Aucun trou entre deux photos positionnées')
      }, (e) => setError(e.message)),
    [projectId],
  )
  const interpolateAll = useCallback(
    (ids: number[]) =>
      api.positionsBatch(projectId, { photo_ids: ids, mode: 'interpolate' }).then((r) => {
        afterHeadingChange(r.undo)
        setNotice(`${r.changed} photo(s) placée(s) entre leurs voisines — Ctrl+Z pour annuler`)
      }, (e) => setError(e.message)),
    [projectId, afterHeadingChange],
  )
  const nextIssue = useCallback(() => {
    if (!focusPoint) return
    const c = checkPoints.find((x) => x.start > focusPoint.end) ?? checkPoints.find((x) => x.start > focusPoint.start)
    if (c) focusOn(c)
    else setNotice('Plus aucun point à vérifier après celui-ci')
  }, [focusPoint, checkPoints, focusOn])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.closest('input, textarea, select') || showImport || confirmExclude || addingBasemap || stopCompare || valueDlg || confirmInterp || showSettings) return
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
        const dir = e.key === 'ArrowRight' ? 1 : -1
        const target = i < 0 ? stepIdx(-1, 1) : stepIdx(i, dir, e.shiftKey ? 10 : 1)
        if (dir === 1 && !e.shiftKey && editMode && carryPos && current && target !== i) carryCorrection(current, photos[target])
        goIdx(target)
      } else if (e.key === 'Home') goIdx(stepIdx(-1, 1))
      else if (e.key === 'End') goIdx(stepIdx(photos.length, -1))
      else if (e.key === 'PageDown' || e.key === 'PageUp') {
        if (!sequences.length) return
        const i = current?.idx ?? -1
        const target =
          e.key === 'PageDown' ? sequences.find((s) => s.start_idx > i) : [...sequences].reverse().find((s) => s.start_idx < i && !(current?.sequence_id === s.id && s.start_idx === i))
        if (target) goIdx(target.start_idx)
      } else if (isPnx && 'dDfFsScC'.includes(e.key)) {
        return // Panoramax project: the cut of the published sequences cannot change
      } else if (e.key === 'd' || e.key === 'D') {
        markStart()
      } else if (e.key === 'f' || e.key === 'F' || e.key === 's' || e.key === 'S') {
        finishSequence()
      } else if (e.key === 'c' || e.key === 'C') {
        if (current) api.cutAt(projectId, current.id).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'X' && e.shiftKey) {
        if (current?.excluded) api.excludePhotos(projectId, { photo_ids: [current.id] }, false).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'x' || e.key === 'Delete') {
        if (range && seqStart == null && range[1] > range[0]) {
          // a range drawn on the timeline: exclude it all, after confirmation
          const n = photos.slice(range[0], range[1] + 1).filter((p) => !p.excluded).length
          if (n > 1) setConfirmExclude({ range, n })
          else excludeRange(range, n)
        } else if (current) {
          // exclude and move on: pressing the key repeatedly removes a series of photos
          if (!current.excluded) api.excludePhotos(projectId, { photo_ids: [current.id] }).then(applyState, (er) => setError(er.message))
          // the photo marked "Début" is excluded: the start moves to the next photo that is not
          if (seqStart === current.idx) {
            const next = nextKept(current.idx)
            setSeqStart(next ? next.idx : null)
            if (!next) setRange(null)
          }
          goIdx(showExcluded ? current.idx + 1 : stepIdx(current.idx, 1))
        }
      } else if (e.key === 'n' || e.key === 'N') {
        const i = current?.idx ?? -1
        const list = checkPoints
        const k = e.shiftKey ? list.map((c) => c.start < i).lastIndexOf(true) : list.findIndex((c) => c.start > i)
        if (k < 0) {
          setNotice(list.length ? (e.shiftKey ? 'Aucun point à vérifier avant cette photo' : 'Aucun point à vérifier après cette photo') : 'Rien à vérifier')
        } else {
          const c = list[k]
          focusOn(c)
          setNotice(`${k + 1}/${list.length} · photos ${c.start + 1}${c.end > c.start ? ` → ${c.end + 1}` : ''} · ${ISSUE_TEXT[c.kind].one} : ${issueDetail(c)}`)
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
  }, [photos, current, range, sequences, detail, projectId, showImport, goIdx, applyState, afterHeadingChange, undoRedo, markStart, finishSequence, seqStart, nextKept, stepIdx, showExcluded, editMode, carryPos, carryCorrection, isPnx, checkPoints, focusOn, excludeRange, confirmExclude, addingBasemap, stopCompare, valueDlg, confirmInterp, showSettings])

  // Right click on a photo of the map / timeline: the selection if the photo is in it, otherwise this photo
  const photosContext = (idx: number | null, x: number, y: number) => {
    if (range && (idx == null || (idx >= range[0] && idx <= range[1]))) setCtx({ x, y, kind: 'photos', range })
    else if (idx != null) {
      goIdx(idx)
      setCtx({ x, y, kind: 'photos', range: [idx, idx] })
    }
  }
  const ctxItems = (): { title: string; items: MenuItem[] } => {
    if (!ctx) return { title: '', items: [] }
    if (ctx.kind === 'sequence') {
      const sq = sequences.find((x) => x.id === ctx.sequenceId)
      return {
        title: sq ? `${sq.name} (${sq.count} photos)` : 'Séquence',
        items: [
          {
            label: 'Recaler sur OpenStreetMap…',
            disabled: !sq,
            onClick: () => {
              if (!sq) return
              goIdx(sq.start_idx)
              setSnapOpen({ scope: 'sequence', sequenceId: sq.id })
            },
          },
        ],
      }
    }
    const r = ctx.range as [number, number]
    const inSeq = photos[r[0]]?.sequence_id ?? null
    const sameSeq = inSeq != null && photos.slice(r[0], r[1] + 1).every((p) => p.sequence_id === inSeq)
    const sq = sameSeq ? sequences.find((x) => x.id === inSeq) : undefined
    const these = r[0] === r[1] ? 'de cette photo' : `de ces ${r[1] - r[0] + 1} photos`
    const items: MenuItem[] = [
      {
        label: r[0] === r[1] ? 'Recaler cette photo sur OpenStreetMap…' : `Recaler ces ${r[1] - r[0] + 1} photos sur OpenStreetMap…`,
        onClick: () => setSnapOpen({ scope: 'custom', sequenceId: inSeq, bounds: r }),
      },
      { label: `Décalage du cap (sens de déplacement) ${these}…`, onClick: () => setValueDlg({ kind: 'offset', range: r }) },
      { label: `Orientation de la caméra ${these}…`, onClick: () => setValueDlg({ kind: 'yaw', range: r }) },
    ]
    if (!isPnx && photos.slice(r[0], r[1] + 1).every((p) => p.sequence_id == null))
      items.push({
        label: r[0] === r[1] ? 'Créer une séquence avec cette photo' : `Créer une séquence avec ces ${r[1] - r[0] + 1} photos`,
        onClick: () =>
          api.createSequence(projectId, r[0], r[1]).then((st) => {
            applyState({ ...st, done: `Séquence créée : photos ${r[0] + 1} → ${r[1] + 1}` })
            setRange(null)
            setSeqStart(null)
          }, (er) => setError(er.message)),
      })
    if (sq)
      items.push({
        label: `Recaler toute la séquence « ${sq.name} »…`,
        onClick: () => setSnapOpen({ scope: 'sequence', sequenceId: sq.id }),
      })
    return { title: r[0] === r[1] ? `Photo ${r[0] + 1}` : `Photos ${r[0] + 1} → ${r[1] + 1}`, items }
  }

  const chooseBasemap = (id: string) => {
    if (id === '__add') {
      setAddingBasemap(true)
      return
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
        <button className="brand-back" onClick={onBack} title="GeoSillage — retour aux projets" aria-label="Retour aux projets">
          ← <img src="/logo.svg" alt="" width="20" height="20" />
        </button>
        <strong className="ellipsis project-title" title={project.name}>
          {project.name}
        </strong>
        {isPnx ? (
          <span className="badge" title={`Séquences déjà publiées sur ${project.pnx_instance ?? 'Panoramax'} : corrigées ici, puis envoyées (onglet Envoi)`}>
            Panoramax
          </span>
        ) : (
          <button className="primary" onClick={() => setShowImport(true)}>
            Importer
          </button>
        )}
        <span className="tool-sep" />
        <div className="btn-group">
          <button disabled={!undoState.undo} onClick={() => undoRedo('undo')} title={undoState.undo ? `Annuler : ${undoState.undo} (Ctrl+Z)` : 'Rien à annuler'}>
            ↶ Annuler
          </button>
          <button disabled={!undoState.redo} onClick={() => undoRedo('redo')} title={undoState.redo ? `Rétablir : ${undoState.redo} (Ctrl+Y)` : 'Rien à rétablir'}>
            ↷ Rétablir
          </button>
        </div>
        {!isPnx && (
          <>
            <span className="tool-sep" />
            <div className="btn-group" role="group" aria-label="Découpage en séquences">
              <button
                disabled={!current}
                onClick={() => current && api.cutAt(projectId, current.id).then(applyState, (er) => setError(er.message))}
                title="Découper la sortie avant la photo courante (C)"
              >
                ✂ Couper
              </button>
              <SeqButtons current={current} seqStart={seqStart} range={range} onStart={markStart} onFinish={finishSequence} />
            </div>
          </>
        )}
        <span className="tool-sep" />
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
        <button onClick={() => setShowSettings(true)} title="Réglages : surcouche Panoramax, fonds de carte ajoutés, calcul du cap">
          ⚙ Réglages
        </button>
        <button onClick={() => setShowHelp(true)} title="Raccourcis clavier (?)" aria-label="Raccourcis clavier">
          ?
        </button>
      </header>
      <StepBar
        project={project}
        photos={photos}
        sequences={sequences}
        quality={quality}
        tab={tab}
        onTab={setTab}
        onIssues={(st) => setIssuesStep(st)}
        issueCounts={{ dups: issuesByStep.dups.length, gps: issuesByStep.gps.length, seq: issuesByStep.seq.length }}
      />
      {error && (
        <div className="error banner" onClick={() => setError(null)}>
          {error} <span className="muted">(cliquer pour fermer)</span>
        </div>
      )}
      <main className="main" style={{ gridTemplateColumns: `1fr 6px ${panelWidth}px` }}>
        <div className="center">
          <div className="map-area">
          <PhotoMap
            onContextMenu={(id, x, y) => photosContext(id == null ? null : photos.find((p) => p.id === id)?.idx ?? null, x, y)}
            photos={mapPhotos}
            sequences={sequences}
            basemap={basemap}
            selectedId={selected}
            range={snapOpen && snapHighlight ? snapHighlight : range}
            editMode={editMode}
            sync={sync}
            overlay={overlay}
            follow={follow}
            centerTick={centerTick}
            snapPreview={snapPreview}
            viewAzimuth={(tab === 'photo' || tab === 'sync') && current?.heading != null ? (((current.heading + viewYaw) % 360) + 360) % 360 : null}
            viewYaw={tab === 'sync' ? viewYaw : 0}
            onSyncOffset={onSyncOffset}
            onSelect={(id, extend) => {
              const p = photos.find((x) => x.id === id)
              if (p) goIdx(p.idx, extend)
            }}
            onMove={(id, lat, lon) => {
              // remembered at once (→ may be pressed before the photos are reloaded): the shift just made, added to the
              // correction this photo already carried if it is the one holding it
              const p = photos.find((x) => x.id === id)
              const c = lastCarry.current
              const before = c?.id === id ? { lat: c.lat, lon: c.lon } : p?.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : null
              if (before) {
                const d = metersBetween(before.lat, before.lon, lat, lon)
                const base = c?.id === id ? c : { east: 0, north: 0 }
                lastCarry.current = { id, east: base.east + d.east, north: base.north + d.north, lat, lon }
              } else lastCarry.current = null
              api.setPosition(projectId, id, lat, lon).then((r) => afterHeadingChange(r.undo), (er) => setError(er.message))
            }}
          />
          <MapLegend panoramax={overlay.enabled ? overlay.url : null} />
          {(seqStart != null || (range && range[1] > range[0])) && !snapOpen && (
            <div className="selection-chip small-text" role="status">
              {seqStart != null ? (
                <>
                  <strong>Début : photo {seqStart + 1}</strong>
                  {current && current.idx !== seqStart ? ` → ${current.idx + 1} (${Math.abs(current.idx - seqStart) + 1} photos)` : ''} · F pour créer
                  la séquence
                </>
              ) : (
                range && (
                  <>
                    <strong>
                      Photos {range[0] + 1} → {range[1] + 1}
                    </strong>{' '}
                    ({range[1] - range[0] + 1}) · clic droit : actions
                  </>
                )
              )}
              <button
                className="small"
                onClick={() => {
                  setSeqStart(null)
                  setRange(null)
                }}
                title="Désélectionner (Échap)"
              >
                ✕ Échap
              </button>
            </div>
          )}
          </div>
          <div className="map-follow small-text">
            <button
              className={overlay.enabled ? 'small primary' : 'small'}
              aria-pressed={overlay.enabled}
              onClick={() => setOverlay({ ...overlay, enabled: !overlay.enabled })}
              title={`Afficher les photos 360° déjà publiées sur Panoramax (${overlay.url}) et leur date ; visible à partir du zoom 7, photos à partir du zoom 15`}
            >
              Panoramax
            </button>
            <select className="small" value={basemap.id} onChange={(e) => chooseBasemap(e.target.value)} aria-label="Fond de carte" title="Fond de carte">
              {basemaps.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              <option value="__add">+ Ajouter un fond XYZ…</option>
            </select>
            <span className="tool-sep" />
            <button className="small" disabled={!current} onClick={() => setCenterTick((t) => t + 1)} title="Centrer la carte sur la photo courante">
              ◎ Centrer
            </button>
            <label title="Garder la photo courante au centre de la carte pendant la navigation (← →) ; décocher pour une carte fixe">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Suivre
            </label>
            <label title="Photos exclues (X) : masquées sur la carte et sautées par ← → ; cocher pour les revoir et les réintégrer (Maj+X)">
              <input type="checkbox" checked={showExcluded} onChange={(e) => { setShowExcluded(e.target.checked); e.target.blur() }} /> Exclues
            </label>
            {editMode && (
              <label title="Mode Positions : → reporte sur la photo suivante la correction de la photo courante (même décalage par rapport à sa position d'origine), si la suivante n'est pas déjà corrigée. Ctrl+Z annule.">
                <input type="checkbox" checked={carryPos} onChange={(e) => { setCarryPos(e.target.checked); e.target.blur() }} /> Reporter la correction (→)
              </label>
            )}
          </div>
          {issuesStep && (
            <IssuesPanel
              step={issuesStep}
              issues={issuesByStep[issuesStep]}
              current={focusPoint}
              duplicates={project.summary.duplicates}
              onPick={focusOn}
              onIgnore={(i) => ignoreHeadings(photos.slice(i.start, i.end + 1).filter((p) => !p.excluded).map((p) => p.id))}
              onClose={closeIssues}
              onInterpolateAll={askInterpolateAll}
            />
          )}
            {snapOpen && (
              <OsmSnapPanel
                key={`${snapOpen.scope}-${snapOpen.sequenceId}-${snapOpen.bounds?.join('-')}`}
                projectId={projectId}
                initialScope={snapOpen.scope}
                initialBounds={snapOpen.bounds}
                sequenceId={snapOpen.sequenceId}
                timelineRange={seqStart == null ? range : null}
                current={current}
                sequences={sequences}
                photos={photos}
                onPreview={setSnapPreview}
                onRange={setSnapHighlight}
                onDone={(u, moved) => {
                  setSnapOpen(null)
                  setNotice(`${moved} photo(s) recalée(s) sur OpenStreetMap — Ctrl+Z pour annuler`)
                  afterHeadingChange(u)
                }}
                onClose={() => setSnapOpen(null)}
                onError={fail}
              />
            )}
          <Timeline
            photos={photos}
            sequences={sequences}
            selectedIdx={current?.idx ?? null}
            range={snapOpen && snapHighlight ? snapHighlight : range}
            onPick={goIdx}
            onContextMenu={photosContext}
            warnings={quality}
            thumbUrl={(id) => api.thumbUrl(projectId, id)}
            storageKey={`pss-timeline-${projectId}`}
          />
          {ctx && <ContextMenu x={ctx.x} y={ctx.y} {...ctxItems()} onClose={() => setCtx(null)} />}
        </div>
        <div className="resizer" onMouseDown={startResize} title="Redimensionner" />
        <aside className="side">
          <nav className="tabs" role="tablist">
            {(
              [
                ['photo', 'Photo'],
                ['sequences', 'Séquences'],
                ['sync', 'Synchro'],
                ['export', 'Export et envoi'],
                ['send', 'Envoi'],
                ['summary', 'Bilan'],
              ] as [Tab, string][]
            ).filter(([t]) => (isPnx ? t !== 'export' : t !== 'send')).map(([t, label]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
                {label}
                {t === 'sequences' && <span className="count">{sequences.length}</span>}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'photo' && focusPoint && (
              <CheckCard
                issue={focusLive ?? focusPoint}
                fixed={!focusLive}
                index={focusLive ? checkPoints.indexOf(focusLive) : -1}
                total={checkPoints.length}
                detail={detail}
                editMode={editMode}
                interpolable={canInterpolate(focusPoint, photos)}
                onPositions={() => setEditMode(true)}
                onCompare={() => setStopCompare([focusPoint.start, focusPoint.end])}
                onAction={fixIssue}
                onNext={nextIssue}
                onClose={() => setFocusPoint(null)}
              />
            )}
            {tab === 'photo' &&
              (detail ? (
                <PhotoTab
                  projectId={projectId}
                  photo={detail}
                  count={photos.length}
                  sequences={sequences}
                  range={range}
                  seqButtons={isPnx ? null : <SeqButtons current={current} seqStart={seqStart} range={range} onStart={markStart} onFinish={finishSequence} big />}
                  onView={setViewYaw}
                  onChanged={afterHeadingChange}
                  onError={fail}
                />
              ) : (
                <p className="muted">{photos.length ? 'Cliquez sur une photo de la carte ou de la timeline, ou utilisez ← →.' : 'Importez un dossier de photos pour commencer.'}</p>
              ))}
            {tab === 'sequences' && (
              <SequencesTab
                pnx={isPnx}
                onSeqContext={(sq, x, y) => setCtx({ x, y, kind: 'sequence', sequenceId: sq.id })}
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
                  setNotice('Orientation corrigée')
                  afterHeadingChange()
                }}
                onExported={() => {
                  setNotice('Réexport lancé')
                  refresh()
                }}
                onError={fail}
              />
            )}
            {tab === 'sync' && (
              <SyncTab
                onPreviewIds={setSyncIds}
                onView={setViewYaw}
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
            {tab === 'send' && isPnx && (
              <SendTab projectId={projectId} instance={project.pnx_instance} sequences={sequences} onStarted={refresh} onError={fail} />
            )}
            {tab === 'export' && !isPnx && (
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
                  {!isPnx && (
                    <button className="small" onClick={() => api.checkFiles(projectId).then(refresh)} title="Signaler les fichiers sources introuvables">
                      Vérifier les fichiers
                    </button>
                  )}
                  {project.summary.thumbs_failed > 0 && (
                    <button className="small" onClick={() => api.retryThumbs(projectId).then(refresh)}>
                      Relancer les miniatures en échec
                    </button>
                  )}
                </div>
                <RideHeadings projectId={projectId} onDone={(u) => afterHeadingChange(u)} onError={fail} />
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
      <JobBar jobs={project.jobs} projectId={projectId} projectName={project.name} />
      {showImport && <ImportDialog projectId={projectId} onClose={() => setShowImport(false)} onStarted={refresh} />}
      {confirmInterp && (
        <Confirm
          title={`Placer ${confirmInterp.length} photo(s) entre leurs voisines ?`}
          confirmLabel={`Placer ${confirmInterp.length} photo(s)`}
          onCancel={() => setConfirmInterp(null)}
          onConfirm={() => {
            interpolateAll(confirmInterp)
            setConfirmInterp(null)
          }}
        >
          <p>
            Chaque photo sans position prise entre deux photos positionnées est placée entre elles, selon l'heure de prise de vue. Les photos en
            début ou en fin de sortie restent à placer. Ctrl+Z annule.
          </p>
        </Confirm>
      )}
      {confirmExclude && (
        <Confirm
          title={`Exclure ${confirmExclude.n} photos ?`}
          confirmLabel={`Exclure ${confirmExclude.n} photos`}
          danger
          onCancel={() => setConfirmExclude(null)}
          onConfirm={() => {
            excludeRange(confirmExclude.range, confirmExclude.n)
            setConfirmExclude(null)
          }}
        >
          <p>
            Photos {confirmExclude.range[0] + 1} → {confirmExclude.range[1] + 1} de la plage sélectionnée. Elles ne sont ni supprimées ni
            exportées ; Ctrl+Z annule.
          </p>
        </Confirm>
      )}
      {showSettings && (
        <SettingsDialog
          project={project}
          overlay={overlay}
          onOverlay={setOverlay}
          custom={custom}
          onRemoveBasemap={(id) => {
            removeBasemap(id)
            if (basemapId === id) chooseBasemap('osm')
          }}
          onHeadingsSaved={() => {
            setNotice('Caps recalculés')
            lastPhotosKey.current = ''
            refresh()
          }}
          onQualitySaved={() => {
            api.project(projectId).then(setProject, () => undefined)
            api.quality(projectId).then(setQuality, (e) => setError(e.message))
            setNotice('Seuils enregistrés : points à vérifier recalculés')
          }}
          onError={fail}
          onClose={() => setShowSettings(false)}
        />
      )}
      {valueDlg && (
        <ValueDialog
          title={`${valueDlg.kind === 'offset' ? 'Décalage du cap' : 'Orientation de la caméra'} : photos ${valueDlg.range[0] + 1} → ${valueDlg.range[1] + 1}`}
          label={valueDlg.kind === 'offset' ? 'Décalage ajouté aux caps calculés (sens de déplacement)' : 'Angle ajouté à l\'orientation de chaque photo (centre de l\'image)'}
          initial={valueDlg.kind === 'offset' ? '0' : '180'}
          unit="°"
          applyLabel="Appliquer"
          help={
            valueDlg.kind === 'offset'
              ? 'Le cap est la direction dans laquelle on avance (flèches de navigation). Remplace le décalage déjà posé sur ces photos ; 0 le retire. Les caps manuels ne changent pas. L\'orientation de la caméra ne change pas. Ctrl+Z annule.'
              : 'L\'orientation est l\'angle entre le centre de l\'image et le sens de déplacement : caméra mal alignée sur le casque, ou à l\'envers (180°). Le cap ne change pas ; le fichier JPEG n\'est pas tourné. Ctrl+Z annule.'
          }
          onCancel={() => setValueDlg(null)}
          onApply={(v) => {
            const r = valueDlg.range
            const target = { start_idx: r[0], end_idx: r[1] }
            setValueDlg(null)
            ;(valueDlg.kind === 'offset' ? api.headingOffset(projectId, target, v) : api.rotateYaw(projectId, target, v)).then(
              (res) => {
                afterHeadingChange(res.undo)
                setNotice(`${valueDlg.kind === 'offset' ? 'Décalage du cap' : 'Orientation'} ${v > 0 ? '+' : ''}${v}° : photos ${r[0] + 1} → ${r[1] + 1}`)
              },
              (er) => setError(er.message),
            )
          }}
        />
      )}
      {addingBasemap && (
        <AddBasemap
          onCancel={() => setAddingBasemap(false)}
          onAdd={(name, url, attribution) => {
            const b = addBasemap(name, url, attribution)
            setAddingBasemap(false)
            chooseBasemap(b.id)
          }}
        />
      )}
      {stopCompare && (
        <StopCompare
          projectId={projectId}
          photos={photos}
          range={stopCompare}
          onClose={() => setStopCompare(null)}
          onGo={(idx) => {
            setStopCompare(null)
            goIdx(idx)
            setTab('photo')
          }}
          onDone={(s, n) => {
            setStopCompare(null)
            applyState({ ...s, done: `${n} photo(s) de l'arrêt exclue(s) — Ctrl+Z pour annuler` })
          }}
          onError={fail}
        />
      )}
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
