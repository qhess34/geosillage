import { useState } from 'react'
import { api, Project, UndoState } from './api'
import { fmtDistance, fmtDuration, fmtTime } from './format'
import YawRotate from './YawRotate'
import { CAP_HELP, ORIENTATION_HELP } from './CapOrientation'

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

// Bilan tab: figures of the ride, maintenance buttons, headings of the whole ride, source folders
export default function SummaryTab({
  projectId,
  project,
  isPnx,
  onRefresh,
  onHeadingsChanged,
  onError,
}: {
  projectId: string
  project: Project
  isPnx: boolean
  onRefresh: () => void
  onHeadingsChanged: (u?: UndoState) => void
  onError: (m: string) => void
}) {
  return (
    <>
      <Summary p={project} />
      <div className="row wrap">
        {!isPnx && (
          <button className="small" onClick={() => api.checkFiles(projectId).then(onRefresh)} title="Signaler les fichiers sources introuvables">
            Vérifier les fichiers
          </button>
        )}
        {project.summary.thumbs_failed > 0 && (
          <button className="small" onClick={() => api.retryThumbs(projectId).then(onRefresh)}>
            Relancer les miniatures en échec
          </button>
        )}
      </div>
      <RideHeadings projectId={projectId} onDone={(u) => onHeadingsChanged(u)} onError={onError} />
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
  )
}
