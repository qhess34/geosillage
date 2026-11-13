import { locale, t, useLang } from './i18n'
import { Job, seqColor, Sequence } from './api'
import { publicationStates, PublishButton, PublishOptionsPanel, usePublishOptions, viewerUrl } from './Publication'

// Step « Envoi » of a ride: each exported sequence is sent from its last export (one sequence = one upload).
// Connection, visibility and attributes below are shared by the « Publier » buttons.
export default function PublishTab({
  projectId,
  sequences,
  jobs,
  onStarted,
  onError,
}: {
  projectId: string
  sequences: Sequence[]
  jobs: Job[]
  onStarted: () => void
  onError: (msg: string) => void
}) {
  useLang()
  const publishing = jobs.some((j) => j.kind === 'publish' && j.state === 'running')
  const pub = usePublishOptions()
  return (
    <div className="small-text">
      <p className="muted">{t('send.rideIntro')}</p>
      {sequences.length === 0 ? (
        <p className="muted">{t('exp.noSequence')}</p>
      ) : (
        <ul className="export-list">
          {sequences.map((s, i) => {
            const p = s.last_publication
            return (
              <li key={s.id} className="export-row">
                <span>
                  <span className="chip" style={{ background: seqColor(sequences, s.id) }} /> {i + 1} · {s.name}{' '}
                  <span className="muted">({t('seq.photos', { n: s.count })})</span>{' '}
                  {!s.last_export && <span className="badge">{t('send.exportFirst')}</span>}{' '}
                  {p && (
                    <span className={`badge ${p.state === 'error' || p.state === 'uploading' || s.changed_since_publication ? 'warn-text' : ''}`} title={p.message ?? p.instance}>
                      {s.changed_since_publication ? t('exp.changedSincePub') : t('exp.pubOn', { state: publicationStates()[p.state], date: new Date(p.ts * 1000).toLocaleDateString(locale()) })}
                    </span>
                  )}
                </span>
                {s.last_export && (
                  <span className="row export-row-actions">
                    {p?.first_picture_id && (
                      <a className="button-link small" href={viewerUrl(p.instance, p.first_picture_id)} target="_blank" rel="noreferrer">
                        {t('exp.view')}
                      </a>
                    )}
                    <PublishButton projectId={projectId} s={s} o={pub} running={publishing} onStarted={onStarted} onError={onError} />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <PublishOptionsPanel o={pub} projectId={projectId} sequences={sequences} running={publishing} onStarted={onStarted} onError={onError} />
    </div>
  )
}
