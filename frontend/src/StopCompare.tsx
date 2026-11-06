import { useEffect, useState } from 'react'
import { api, PhotoDetail, PhotoRow, SeqState } from './api'
import Viewer360 from './Viewer360'
import { fmtTime } from './format'

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
  const list = photos.slice(range[0], range[1] + 1).filter((p) => !p.excluded)
  const [keep, setKeep] = useState<Set<number>>(() => new Set(list.map((p) => p.id)))
  const [focus, setFocus] = useState<PhotoRow | null>(list[0] ?? null)
  // orientation of the photo shown (yaw / pitch / roll), as in the Photo tab
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  useEffect(() => {
    if (focus) api.photo(projectId, focus.id).then(setDetail, () => setDetail(null))
  }, [projectId, focus])
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
      <div className="modal wide-modal stop-compare" role="dialog" aria-label="Comparer les photos de l'arrêt">
        <h2>
          Arrêt : photos {range[0] + 1} → {range[1] + 1}
        </h2>
        <p className="small-text muted">
          Cochez la ou les photos à garder (la plus nette, la mieux cadrée — pas forcément la première) ; les autres seront
          exclues. Clic sur une vignette : la photo dans la visionneuse 360° (la direction regardée est gardée d'une photo à
          l'autre). Ctrl+Z annule.
        </p>
        {focus && (
          <figure className="stop-preview">
            <Viewer360
              key={focus.id}
              thumbUrl={api.thumbUrl(projectId, focus.id)}
              imageUrl={api.imageUrl(projectId, focus.id)}
              alt={`Photo ${focus.idx + 1}`}
              height={300}
              yaw={detail?.id === focus.id ? detail.yaw_offset : null}
              pitch={detail?.id === focus.id ? detail.pitch_orig : null}
              roll={detail?.id === focus.id ? detail.roll_orig : null}
            />
            <figcaption className="small-text muted">
              Photo {focus.idx + 1} · {fmtTime(focus.ts, false)}
            </figcaption>
          </figure>
        )}
        <ul className="stop-grid">
          {list.map((p) => (
            <li key={p.id} className={`${keep.has(p.id) ? 'keep' : 'drop'}${focus?.id === p.id ? ' shown' : ''}`}>
              <button className="stop-thumb" onClick={() => setFocus(p)} title="Afficher dans la visionneuse 360°">
                <img src={api.thumbUrl(projectId, p.id)} alt={`Photo ${p.idx + 1}`} loading="lazy" />
              </button>
              <label>
                <span>
                  <input type="checkbox" checked={keep.has(p.id)} onChange={() => toggle(p.id)} />
                  <strong>Photo {p.idx + 1}</strong>
                  <span className="muted">{fmtTime(p.ts, false)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button className="link small-text" onClick={() => setKeep(new Set(list.map((p) => p.id)))}>
            Tout garder
          </button>
          <span className="spacer" />
          <button onClick={() => focus && onGo(focus.idx)} disabled={!focus}>
            Ouvrir dans la visionneuse
          </button>
          <button onClick={onClose}>Fermer</button>
          <button className="primary" disabled={!drop.length || !keep.size} onClick={apply} title={keep.size ? '' : 'Gardez au moins une photo'}>
            {drop.length ? `Exclure ${drop.length} photo(s), garder ${keep.size}` : 'Décochez les photos à exclure'}
          </button>
        </div>
      </div>
    </div>
  )
}
