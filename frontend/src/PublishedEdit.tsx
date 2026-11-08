import { useState } from 'react'
import { locale, rich, t, useLang } from './i18n'
import { api, PublishedDiff, Sequence } from './api'
import { Confirm } from './Dialogs'

// Séquences tab: corrections of a sequence already on Panoramax (published by the application, or linked)

export default function PublishedEdit({
  projectId,
  s,
  onStarted,
  onError,
}: {
  projectId: string
  s: Sequence
  onStarted: () => void
  onError: (msg: string) => void
}) {
  useLang()
  const [diff, setDiff] = useState<PublishedDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [delExcluded, setDelExcluded] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const compare = () => {
    setBusy(true)
    api.pnxCompare(projectId, s.id).then(
      (d) => {
        setDiff(d)
        setBusy(false)
      },
      (e) => {
        setBusy(false)
        onError(e.message)
      },
    )
  }
  const started = () => {
    setDiff(null)
    setConfirm(false)
    onStarted()
  }

  if (!s.last_publication) return null // only sequences published by the application (or a Panoramax project)

  const nothing = diff && diff.photos_to_update === 0 && diff.to_delete === 0
  return (
    <div className="published-edit small-text">
      {!diff ? (
        <button className="small" disabled={busy} onClick={compare} title={t('pe.compareTitle')}>
          {busy ? t('pe.comparing') : t('pe.compare')}
        </button>
      ) : (
        <div className="confirm-box">
          {nothing ? (
            <div>{t('pe.upToDate')}</div>
          ) : (
            <div>
              {t('pe.toSend', { n: diff.photos_to_update, p: diff.positions, h: diff.headings, o: diff.orientations })}
              {diff.to_delete > 0 && t('pe.excludedSince', { n: diff.to_delete })}.
            </div>
          )}
          {diff.not_published > 0 && (
            <div className="warn-text">
              {t('pe.notPublished', { n: diff.not_published })}
            </div>
          )}
          {!nothing && (
            <>
              {diff.to_delete > 0 && (
                <label className="option-line">
                  <input type="checkbox" checked={delExcluded} onChange={(e) => setDelExcluded(e.target.checked)} /> {t('pe.deleteToo', { n: diff.to_delete })}
                </label>
              )}
              <div className="muted">
                {t('pe.note')}
              </div>
              <button className="small primary" onClick={() => setConfirm(true)}>
                {t('pe.push')}
              </button>
              {confirm && (
                <Confirm
                  title={t('pe.pushTitle')}
                  confirmLabel={t('pe.send')}
                  danger={delExcluded && diff.to_delete > 0}
                  onCancel={() => setConfirm(false)}
                  onConfirm={() => api.pnxPush(projectId, s.id, delExcluded).then(started, (e) => onError(e.message))}
                >
                  <p>
                    {rich(t('pe.pushBody', { n: diff.photos_to_update, instance: diff.instance.replace(/^https?:\/\//, '') }))}
                    {delExcluded && diff.to_delete > 0 ? t('pe.pushDeleted', { n: diff.to_delete }) : ''}.
                  </p>
                </Confirm>
              )}
            </>
          )}
          <div className="row wrap">
            {diff.last_edit && (
              <button
                className="small"
                onClick={() => api.pnxRevert(projectId, s.id).then(started, (e) => onError(e.message))}
                title={t('pe.revertTitle')}
              >
                {t('pe.revert', { date: new Date(diff.last_edit.ts * 1000).toLocaleString(locale()) })}
              </button>
            )}
            <button className="small" onClick={() => setDiff(null)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
