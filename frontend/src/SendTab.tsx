import { seqColor, Sequence } from './api'
import PublishedEdit from './PublishedEdit'
import { t, useLang } from './i18n'

// Panoramax project: send the corrections of each sequence (replaces the Export tab)
export default function SendTab({
  projectId,
  instance,
  sequences,
  onStarted,
  onError,
}: {
  projectId: string
  instance: string | null
  sequences: Sequence[]
  onStarted: () => void
  onError: (msg: string) => void
}) {
  useLang()
  const changed = sequences.filter((s) => s.changed_since_publication)
  return (
    <div className="small-text">
      <h3>{t('send.heading')}</h3>
      <p className="muted">
        {t('send.intro', { instance: instance?.replace(/^https?:\/\//, '') ?? 'Panoramax' })}
      </p>
      <p>{changed.length ? t('send.changed', { n: changed.length }) : t('send.none')}</p>
      <ul className="seq-list">
        {sequences.map((s) => (
          <li key={s.id} className="seq">
            <div className="seq-head">
              <span className="chip" style={{ background: seqColor(sequences, s.id) }} />
              <strong className="grow ellipsis">{s.name}</strong>
              <span className="muted">{t('send.photosShort', { n: s.count })}</span>
            </div>
            {s.changed_since_publication && <span className="badge warn-text">{t('send.toSend')}</span>}
            <PublishedEdit projectId={projectId} s={s} onStarted={onStarted} onError={onError} />
          </li>
        ))}
      </ul>
    </div>
  )
}
