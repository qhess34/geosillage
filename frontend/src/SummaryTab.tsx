import { api, Project } from './api'
import { fmtDistance, fmtDuration, fmtShift, fmtTime } from './format'
import { t, useLang } from './i18n'

// Orange rows are links to the matching list (points to check of a step, excluded photos) when there is one
export interface SummaryLinks {
  gps: (() => void) | null
  dups: (() => void) | null
  excluded: (() => void) | null
}

function Summary({ p, onSettings, links }: { p: Project; onSettings?: () => void; links?: SummaryLinks }) {
  useLang()
  const s = p.summary
  const row = (label: string, value: React.ReactNode, warn = false, go?: (() => void) | null, goTitle = t('sum.goList')) => (
    <tr className={warn ? 'warn' : ''}>
      <th>{label}</th>
      <td>
        {warn && go ? (
          <button className="link-btn" onClick={go} title={goTitle}>
            {value} ›
          </button>
        ) : (
          value
        )}
      </td>
    </tr>
  )
  return (
    <table className="summary">
      <tbody>
        {row(t('sum.photos'), s.total)}
        {row(t('sum.geolocated'), s.geolocated)}
        {row(t('sum.noGps'), s.no_gps, s.no_gps > 0, links?.gps)}
        {row(t('sum.noDate'), s.no_date, s.no_date > 0)}
        {row(t('sum.duplicates'), s.duplicates, s.duplicates > 0, links?.dups)}
        {row(t('sum.gpsAnomalies'), t('sum.gpsAnomaliesVal', { n: s.gps_anomalies, jumps: s.gps_jumps }), s.gps_anomalies > 0, links?.gps)}
        {row(t('sum.interruptions'), s.interruptions, s.interruptions > 0)}
        {row(t('sum.unreadable'), s.unreadable, s.unreadable > 0)}
        {row(t('sum.excluded'), s.excluded, s.excluded > 0, links?.excluded, t('sum.showExcluded'))}
        {s.missing_files > 0 && row(t('sum.missing'), s.missing_files, true)}
        {row(t('sum.media'), p.media === 'flat' ? t('sum.mediaFlat') : p.media === '360' ? t('sum.media360') : '—')}
        {s.median_interval_s != null &&
          row(
            t('sum.interval'),
            <>
              {s.median_interval_s.toLocaleString(undefined, { maximumFractionDigits: 1 })} s
              {s.interval_warning && (
                <div className="small-text">
                  {t('sum.intervalWarn', { gap: p.settings.gap_seconds })}{' '}
                  {onSettings && (
                    <button className="small" onClick={onSettings}>
                      ⚙ {t('sum.openSettings')}
                    </button>
                  )}
                </div>
              )}
            </>,
            s.interval_warning,
          )}
        {s.clock.state !== 'none' &&
          row(
            t('sum.clock'),
            <>
              {s.clock.state === 'ok' && t('sum.clockOk')}
              {s.clock.state === 'shifted' && t('sum.clockShifted', { shift: fmtShift(s.clock.shift_s ?? 0), tz: s.clock.tz ?? '', spread: s.clock.spread_s ?? 0 })}
              {s.clock.state === 'variable' && t('sum.clockVariable')}
              {s.clock.stuck > 0 && <div className="small-text">{t('sum.clockStuck', { n: s.clock.stuck })}</div>}
            </>,
            s.clock.state === 'shifted' || s.clock.state === 'variable' || s.clock.stuck > 0,
          )}
        {row(t('sum.start'), fmtTime(s.start))}
        {row(t('sum.end'), fmtTime(s.end))}
        {row(t('sum.duration'), fmtDuration(s.duration_s))}
        {row(t('sum.distance'), `≈ ${fmtDistance(s.distance_m)}`)}
        {row(t('sum.thumbs'), `${s.thumbs_done} / ${s.total}${s.thumbs_failed ? t('sum.thumbsFailed', { n: s.thumbs_failed }) : ''}`)}
        {row(t('sum.headings'), t('sum.headingsVal', { c: p.headings.computed, m: p.headings.manual, u: p.headings.uncertain }), p.headings.uncertain > 0, links?.gps)}
        {s.cameras.length > 0 && row(t('sum.cameras'), s.cameras.map((c) => `${c.make ?? '?'} ${c.model ?? ''} (${c.count})`).join(', '))}
      </tbody>
    </table>
  )
}

// Bilan tab: figures of the ride, maintenance buttons, source folders (ride settings: RideSettings, Photo tab)
export default function SummaryTab({
  projectId,
  project,
  isPnx,
  onRefresh,
  onSettings,
  links,
}: {
  links?: SummaryLinks
  onSettings?: () => void
  projectId: string
  project: Project
  isPnx: boolean
  onRefresh: () => void
}) {
  useLang()
  return (
    <>
      {isPnx && <p className="muted small-text">{t('sum.pnxHidden')}</p>}
      <Summary p={project} onSettings={onSettings} links={links} />
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
