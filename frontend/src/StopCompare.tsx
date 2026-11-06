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
      <div className="modal wide-modal stop-compare" role="dialog" aria-label="Comparer les photos de l'arrêt">
        <h2>
          Arrêt : photos {range[0] + 1} → {range[1] + 1}
        </h2>
        <p className="small-text muted">
          Cochez la ou les photos à garder (la plus nette, la mieux cadrée — pas forcément la première) ; les autres seront
          exclues. Aucune cochée : toutes sont exclues. Clic sur une vignette : la photo dans la visionneuse 360° (la direction regardée est gardée d'une photo à
          l'autre). Ctrl+Z annule.
        </p>
        {focus && (
          <figure className="stop-preview">
            <Viewer360
              thumbUrl={api.thumbUrl(projectId, focus.id)}
              imageUrl={api.imageUrl(projectId, focus.id)}
              alt={`Photo ${focus.idx + 1}`}
              height={Math.round(Math.min(300, window.innerHeight * 0.35))}
              yaw={shown?.detail?.yaw_offset ?? null}
              pitch={shown?.detail?.pitch_orig ?? null}
              roll={shown?.detail?.roll_orig ?? null}
            />
            <figcaption className="small-text muted">
              Photo {focus.idx + 1} · {fmtTime(focus.ts, false)}
            </figcaption>
          </figure>
        )}
        <ul className="stop-grid">
          {list.map((p) => (
            <li key={p.id} className={`${keep.has(p.id) ? 'keep' : 'drop'}${(asked ?? focus)?.id === p.id ? ' shown' : ''}`}>
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
          <button className="link small-text" onClick={() => setKeep(new Set())} title="Tout décocher, puis cocher la ou les photos à garder">
            Tout désélectionner
          </button>
          <span className="spacer" />
          <button onClick={() => focus && onGo(focus.idx)} disabled={!focus} title="Fermer et aller à cette photo dans l'écran principal">
            Aller à cette photo
          </button>
          <button onClick={onClose}>Fermer</button>
          <button className="primary" disabled={!drop.length} onClick={apply} title={keep.size ? '' : 'Aucune photo de cet arrêt n\'est gardée (Ctrl+Z annule)'}>
            {!drop.length ? 'Décochez les photos à exclure' : keep.size ? `Exclure ${drop.length} photo(s), garder ${keep.size}` : `Exclure les ${drop.length} photos (aucune gardée)`}
          </button>
        </div>
      </div>
    </div>
  )
}
