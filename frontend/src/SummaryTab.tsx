import { useState } from 'react'
import { api, Project, UndoState } from './api'
import { fmtDistance, fmtDuration, fmtTime } from './format'
import YawRotate from './YawRotate'
import { capHelp, orientationHelp } from './CapOrientation'
import { t, useLang } from './i18n'

// logical cut); series of photos: context menu or range tools of the Photo tab
function RideHeadings({ projectId, onDone, onError }: { projectId: string; onDone: (u?: UndoState) => void; onError: (m: string) => void }) {
  useLang()
  const [value, setValue] = useState('0')
  return (
    <div className="small-text ride-headings">
      <h3>{t('sum.rideHeadings')}</h3>
      <p className="muted">
        {t('sum.rideHelp')}
      </p>
      <div className="form-row">
        <span title={`${capHelp()} ${t('sum.headingShiftHelp')}`}>
          {t('sum.headingShift')}
        </span>
        <span>
          <input className="num" type="number" step="0.5" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('sum.headingShiftLabel')} />°
          <button className="small" onClick={() => api.headingOffset(projectId, { all: true }, Number(value) || 0).then((r) => onDone(r.undo), (e) => onError(e.message))}>
            {t('sum.applyAll')}
          </button>
        </span>
      </div>
      <div className="form-row">
        <span title={`${orientationHelp()} ${t('sum.yawHelp')}`}>{t('photo.orient.title')}</span>
        <YawRotate projectId={projectId} target={{ all: true }} what={t('sum.yawWhat')} onDone={onDone} onError={onError} />
      </div>
    </div>
  )
}


function Summary({ p }: { p: Project }) {
  useLang()
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
        {row(t('sum.photos'), s.total)}
        {row(t('sum.geolocated'), s.geolocated)}
        {row(t('sum.noGps'), s.no_gps, s.no_gps > 0)}
        {row(t('sum.noDate'), s.no_date, s.no_date > 0)}
        {row(t('sum.duplicates'), s.duplicates, s.duplicates > 0)}
        {row(t('sum.gpsAnomalies'), t('sum.gpsAnomaliesVal', { n: s.gps_anomalies, jumps: s.gps_jumps }), s.gps_anomalies > 0)}
        {row(t('sum.interruptions'), s.interruptions, s.interruptions > 0)}
        {row(t('sum.unreadable'), s.unreadable, s.unreadable > 0)}
        {row(t('sum.excluded'), s.excluded, s.excluded > 0)}
        {s.missing_files > 0 && row(t('sum.missing'), s.missing_files, true)}
        {row(t('sum.photos360'), s.is_360)}
        {row(t('sum.start'), fmtTime(s.start))}
        {row(t('sum.end'), fmtTime(s.end))}
        {row(t('sum.duration'), fmtDuration(s.duration_s))}
        {row(t('sum.distance'), `≈ ${fmtDistance(s.distance_m)}`)}
        {row(t('sum.thumbs'), `${s.thumbs_done} / ${s.total}${s.thumbs_failed ? t('sum.thumbsFailed', { n: s.thumbs_failed }) : ''}`)}
        {row(t('sum.headings'), t('sum.headingsVal', { c: p.headings.computed, m: p.headings.manual, u: p.headings.uncertain }), p.headings.uncertain > 0)}
        {s.cameras.length > 0 && row(t('sum.cameras'), s.cameras.map((c) => `${c.make ?? '?'} ${c.model ?? ''} (${c.count})`).join(', '))}
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
  useLang()
  return (
    <>
      <Summary p={project} />
      <div className="row wrap">
        {!isPnx && (
          <button className="small" onClick={() => api.checkFiles(projectId).then(onRefresh)} title={t('sum.checkFiles')}>
            {t('sum.checkFilesBtn')}
          </button>
        )}
        {project.summary.thumbs_failed > 0 && (
          <button className="small" onClick={() => api.retryThumbs(projectId).then(onRefresh)}>
            {t('sum.retryThumbs')}
          </button>
        )}
      </div>
      <RideHeadings projectId={projectId} onDone={(u) => onHeadingsChanged(u)} onError={onError} />
      {project.source_dirs.length > 0 && (
        <>
          <h3>{t('sum.sources')}</h3>
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
