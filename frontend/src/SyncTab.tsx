import { useEffect, useState } from 'react'
import { api, PhotoDetail, PhotoRow, Sequence, SyncPoint } from './api'
import Viewer360 from './Viewer360'

interface Props {
  projectId: string
  photo: PhotoDetail | null
  photos: PhotoRow[]
  sequences: Sequence[]
  range: [number, number] | null
  offset: number | null // live offset (preview on the map)
  dragged: { photoId: number; offset: number } | null // last photo placed by dragging, and its offset
  onOffset: (o: number | null) => void
  onGo: (idx: number) => void
  onApplied: () => void
  onNotice: (m: string) => void
  onError: (m: string) => void
}

type Scope = 'all' | 'sequence' | 'range' | 'from'

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const fmt = (o: number) => `${o >= 0 ? '+' : ''}${o.toFixed(1)} s`

export default function SyncTab({ projectId, photo, photos, sequences, range, offset, dragged, onOffset, onGo, onApplied, onNotice, onError }: Props) {
  const [points, setPoints] = useState<SyncPoint[]>([])
  // First sync: the whole ride; later ones: from the current photo on (the GPS delay can change during a ride,
  // and earlier photos must not be moved again nor marked for re-export). The user's choice wins.
  const [scope, setScopeState] = useState<Scope>('all')
  const [scopeChosen, setScopeChosen] = useState(false)
  const setScope = (s: Scope) => {
    setScopeState(s)
    setScopeChosen(true)
  }
  const [keepManual, setKeepManual] = useState(true)
  const [lastApplied, setLastApplied] = useState<number | null>(null)

  useEffect(() => {
    api.syncPoints(projectId).then((r) => {
      setPoints(r.points)
      setLastApplied(r.last_offset_s)
      if (r.last_offset_s != null) setScopeState((s) => (s === 'all' ? 'from' : s))
      if (offset == null && r.last_offset_s != null) onOffset(r.last_offset_s)
    }, () => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const savePoints = (p: SyncPoint[]) => {
    setPoints(p)
    api.saveSyncPoints(projectId, p).catch((e) => onError(e.message))
  }
  const seq = sequences.find((s) => s.id === photo?.sequence_id)
  const idxOf = (id: number) => photos.find((p) => p.id === id)?.idx
  // Calibration points within the scope (offsets measured elsewhere in the ride do not apply here)
  const inScope = (p: SyncPoint) => {
    const i = idxOf(p.photo_id)
    if (i == null) return false
    if (scope === 'from') return photo != null && i >= photo.idx
    if (scope === 'sequence') return photos[i]?.sequence_id != null && photos[i]?.sequence_id === seq?.id
    if (scope === 'range') return range != null && i >= range[0] && i <= range[1]
    return true
  }
  const scoped = points.filter(inScope)
  const med = scoped.length ? median(scoped.map((p) => p.offset_s)) : null
  const spread = points.length > 1 ? Math.max(...points.map((p) => p.offset_s)) - Math.min(...points.map((p) => p.offset_s)) : 0

  const apply = () => {
    if (offset == null) return
    api
      .syncApply(projectId, {
        offset_s: offset,
        scope,
        sequence_id: scope === 'sequence' ? seq?.id : undefined,
        start_idx: scope === 'range' ? range?.[0] : scope === 'from' ? photo?.idx : undefined,
        end_idx: scope === 'range' ? range?.[1] : undefined,
        keep_manual: keepManual,
      })
      .then((r) => {
        setLastApplied(offset)
        if (!scopeChosen && scope === 'all') setScopeState('from')
        onApplied()
        onNotice(
          `Synchronisation ${fmt(offset)} : ${r.changed} photo(s)` +
            (r.kept_manual ? `, ${r.kept_manual} correction(s) manuelle(s) gardée(s)` : '') +
            (r.uncovered ? `, ${r.uncovered} hors trace` : ''),
        )
      }, (e) => onError(e.message))
  }

  return (
    <div className="sync">
      {photo ? (
        <>
          <Viewer360 thumbUrl={api.thumbUrl(projectId, photo.id)} imageUrl={api.imageUrl(projectId, photo.id)} alt={photo.filename} height={260} />
          <div className="photo-title">
            <strong>{photo.filename}</strong>
            <span className="muted">
              {photo.idx + 1} / {photos.length}
            </span>
          </div>
        </>
      ) : (
        <p className="muted">Choisissez une photo (carte, timeline, ← →).</p>
      )}
      <ol className="small-text sync-help">
        <li>Repérez dans la photo un élément visible sur la vue satellite (passage piéton, intersection, bâtiment…).</li>
        <li>Faites glisser le marqueur orange <strong>le long de la trace</strong> jusqu'à cet endroit : le décalage s'affiche, et toutes les photos se décalent en aperçu (points orange).</li>
        <li>Vérifiez sur d'autres photos (← →), ajoutez des points de calage, puis appliquez.</li>
      </ol>

      <div className="sync-offset">
        <span>Décalage :</span>
        <strong className="big">{offset == null ? '—' : fmt(offset)}</strong>
        <input
          type="range"
          min={-5}
          max={10}
          step={0.1}
          value={offset ?? 0}
          onChange={(e) => onOffset(Number(e.target.value))}
          aria-label="Décalage en secondes"
        />
        <input
          className="num"
          type="number"
          step={0.1}
          value={offset ?? ''}
          onChange={(e) => onOffset(e.target.value === '' ? null : Number(e.target.value))}
          aria-label="Décalage"
        />
      </div>
      {lastApplied != null && <div className="small-text muted">Dernier décalage appliqué : {fmt(lastApplied)}</div>}

      <div className="row wrap">
        <button
          className="small"
          disabled={!dragged}
          title={dragged ? '' : 'Faites d\'abord glisser le marqueur orange d\'une photo'}
          onClick={() =>
            dragged && savePoints([...points.filter((p) => p.photo_id !== dragged.photoId), { photo_id: dragged.photoId, offset_s: dragged.offset }])
          }
        >
          {dragged ? `Ajouter le calage de la photo ${(idxOf(dragged.photoId) ?? -1) + 1} (${fmt(dragged.offset)})` : 'Ajouter un point de calage'}
        </button>
        {med != null && (
          <button className="small" onClick={() => onOffset(Math.round(med * 10) / 10)}>
            Utiliser la médiane ({fmt(med)}{scoped.length < points.length ? `, ${scoped.length} point(s) de la portée` : ''})
          </button>
        )}
      </div>
      {points.length > 0 && (
        <>
          <h3>Points de calage ({points.length})</h3>
          {points.length > 1 && (
            <p className={`small-text ${spread > 1 ? 'warn-text' : 'muted'}`}>
              Écart entre points : {spread.toFixed(1)} s{spread > 1 ? ' — retard variable : appliquez par tronçons (« À partir de cette photo »), par séquence ou par plage' : ''}
            </p>
          )}
          <ul className="sync-points small-text">
            {points.map((p) => (
              <li key={p.photo_id}>
                <button className="link" onClick={() => idxOf(p.photo_id) != null && onGo(idxOf(p.photo_id) as number)}>
                  photo {(idxOf(p.photo_id) ?? -1) + 1}
                </button>{' '}
                {fmt(p.offset_s)}
                <button className="small" onClick={() => savePoints(points.filter((x) => x.photo_id !== p.photo_id))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Appliquer</h3>
      <fieldset className="modes small-text">
        <label>
          <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> Toute la sortie
        </label>
        <label title="Le retard GPS peut changer pendant une sortie : les photos d'avant gardent leur décalage et ne sont pas à réexporter">
          <input type="radio" checked={scope === 'from'} disabled={!photo} onChange={() => setScope('from')} /> À partir de cette photo
          {photo ? ` (${photo.idx + 1} → ${photos.length})` : ''}
        </label>
        <label>
          <input type="radio" checked={scope === 'sequence'} disabled={!seq} onChange={() => setScope('sequence')} /> Séquence de la photo
          {seq ? ` (${seq.name})` : ' (photo non classée)'}
        </label>
        <label>
          <input type="radio" checked={scope === 'range'} disabled={!range} onChange={() => setScope('range')} /> Plage
          {range ? ` ${range[0] + 1} → ${range[1] + 1}` : ' (D / F pour la définir)'}
        </label>
        <label>
          <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} /> Garder les positions corrigées à la main
        </label>
      </fieldset>
      <div className="actions">
        <button className="primary" disabled={offset == null || (scope === 'sequence' && !seq) || (scope === 'range' && !range) || (scope === 'from' && !photo)} onClick={apply}>
          Appliquer {offset == null ? '' : fmt(offset)}
        </button>
      </div>
      <p className="small-text muted">
        Retard variable : synchronisez d'abord toute la sortie, puis, plus loin, à partir de la photo où le retard change
        (proposé par défaut après une première synchronisation). Les photos sont placées sur la trace GPS à l'instant de prise de vue + décalage (sans traverser une interruption).
        Les sauts GPS et photos sans GPS reçoivent aussi une position sur la trace. Annulable (Ctrl+Z).
      </p>
    </div>
  )
}
