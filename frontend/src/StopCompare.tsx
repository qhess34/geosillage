import { useEffect, useState } from 'react'
import { api, PhotoDetail, PhotoRow, SeqState } from './api'
import Viewer360 from './Viewer360'
import { fmtTime } from './format'
import { t, useLang } from './i18n'

// Photos of a stop side by side: the user ticks the ones to keep (not necessarily the first one), the others are
// excluded in one go (one undoable operation). The photo clicked is shown in the 360° viewer; the view direction
// is kept from one photo to the next, so the same detail can be compared.
export default function StopCompare({
  projectId,
  photos,
  range,
  onDone,
  onGo,
  onClose,
  onError,
}: {
  projectId: string
  photos: PhotoRow[]
  range: [number, number]
  onDone: (s: SeqState, excluded: number) => void
  onGo: (idx: number) => void
  onClose: () => void
  onError: (msg: string) => void
}) {
  useLang()
  const list = photos.slice(range[0], range[1] + 1).filter((p) => !p.excluded)
  const [keep, setKeep] = useState<Set<number>>(() => new Set(list.map((p) => p.id)))
  // photo shown in the 360° viewer, with its orientation (yaw / pitch / roll, as in the Photo tab). A clicked photo
  // replaces the one shown only once its orientation is known: the viewer then loads it once, in the same view
  // direction (the viewer is kept, not re-created)
  const [shown, setShown] = useState<{ photo: PhotoRow; detail: PhotoDetail | null } | null>(null)
  const [asked, setAsked] = useState<PhotoRow | null>(list[0] ?? null) // last thumbnail clicked
  useEffect(() => {
    if (!asked) return
    let live = true
    api.photo(projectId, asked.id).then(
      (d) => live && setShown({ photo: asked, detail: d }),
      () => live && setShown({ photo: asked, detail: null }),
    )
    return () => {
      live = false
    }
  }, [projectId, asked])
  const focus = shown?.photo ?? null
  const setFocus = setAsked
  const drop = list.filter((p) => !keep.has(p.id))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const toggle = (id: number) => {
    const n = new Set(keep)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setKeep(n)
  }
  const apply = () =>
    api.excludePhotos(projectId, { photo_ids: drop.map((p) => p.id) }).then((s) => onDone(s, drop.length), (e) => onError(e.message))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide-modal stop-compare" role="dialog" aria-label={t('compare.label')}>
        <h2>
          {t('compare.title', { a: range[0] + 1, b: range[1] + 1 })}
        </h2>
        <p className="small-text muted">
          {t('compare.help')}
        </p>
        {focus && (
          <figure className="stop-preview">
            <Viewer360
              thumbUrl={api.thumbUrl(projectId, focus.id)}
              imageUrl={api.imageUrl(projectId, focus.id)}
              alt={t('stoprange.photo', { n: focus.idx + 1 })}
              height={Math.round(Math.min(300, window.innerHeight * 0.35))}
              yaw={shown?.detail?.yaw_offset ?? null}
              pitch={shown?.detail?.pitch_orig ?? null}
              roll={shown?.detail?.roll_orig ?? null}
              flat={shown?.detail ? !shown.detail.is_360 : false}
            />
            <figcaption className="small-text muted">
              {t('stoprange.photo', { n: focus.idx + 1 })} · {fmtTime(focus.ts, false)}
            </figcaption>
          </figure>
        )}
        <ul className="stop-grid">
          {list.map((p) => (
            <li key={p.id} className={`${keep.has(p.id) ? 'keep' : 'drop'}${(asked ?? focus)?.id === p.id ? ' shown' : ''}`}>
              <button className="stop-thumb" onClick={() => setFocus(p)} title={t('compare.showTitle')}>
                <img src={api.thumbUrl(projectId, p.id)} alt={t('stoprange.photo', { n: p.idx + 1 })} loading="lazy" />
              </button>
              <label>
                <span>
                  <input type="checkbox" checked={keep.has(p.id)} onChange={() => toggle(p.id)} />
                  <strong>{t('stoprange.photo', { n: p.idx + 1 })}</strong>
                  <span className="muted">{fmtTime(p.ts, false)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button className="link small-text" onClick={() => setKeep(new Set(list.map((p) => p.id)))}>
            {t('compare.keepAll')}
          </button>
          <button className="link small-text" onClick={() => setKeep(new Set())} title={t('compare.deselectTitle')}>
            {t('compare.deselect')}
          </button>
          <span className="spacer" />
          <button onClick={() => focus && onGo(focus.idx)} disabled={!focus} title={t('compare.gotoTitle')}>
            {t('compare.goto')}
          </button>
          <button onClick={onClose}>{t('common.close')}</button>
          <button className="primary" disabled={!drop.length} onClick={apply} title={keep.size ? '' : t('compare.noneKept')}>
            {!drop.length ? t('compare.untick') : keep.size ? t('compare.excludeKeep', { n: drop.length, k: keep.size }) : t('compare.excludeAll', { n: drop.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
