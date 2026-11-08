import { useEffect, useMemo, useState } from 'react'
import { api, GpxSummary, MANUAL_METHODS, PhotoDetail, PhotoRow, Sequence, SyncPoint, SyncRun } from './api'
import { GpxSection } from './Gpx'
import { rich, t, useLang } from './i18n'
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
  onView: (yawDeg: number) => void // direction looked at in the viewer, relative to the front (map arrows)
  onPreviewIds: (ids: Set<number> | null) => void // photos the preview shows moving (null: all)
  gpx: GpxSummary | null
  onGpx: (g: GpxSummary | null) => void // imported / chosen / forgotten: the reference track changed
  onGpxSnap: () => void
}

type Scope = 'all' | 'sequence' | 'range' | 'from'

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const fmt = (o: number) => `${o >= 0 ? '+' : ''}${o.toFixed(1)} s`

export default function SyncTab({ gpx, onGpx, onGpxSnap, onView, onPreviewIds, projectId, photo, photos, sequences, range, offset, dragged, onOffset, onGo, onApplied, onNotice, onError }: Props) {
  useLang()
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
  // lots of photos per applied offset, reloaded with the photos (after a sync, a correction, an undo…)
  const [runs, setRuns] = useState<SyncRun[]>([])
  useEffect(() => {
    api.syncRuns(projectId).then(setRuns, () => undefined)
  }, [projectId, photos])

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
  // Preview on the map: exactly the photos « Appliquer » would move (scope, and corrected positions kept or not)
  const preview = useMemo(() => {
    const inRange = (p: PhotoRow) =>
      scope === 'all' ||
      (scope === 'from' && photo != null && p.idx >= photo.idx) ||
      (scope === 'sequence' && seq != null && p.sequence_id === seq.id) ||
      (scope === 'range' && range != null && p.idx >= range[0] && p.idx <= range[1])
    // photos without a time are skipped by the synchronisation (timesync.apply) and have no point on the map
    const moved = photos.filter((p) => p.ts != null && inRange(p) && !(keepManual && p.pos_method != null && MANUAL_METHODS.includes(p.pos_method)))
    return { ids: scope === 'all' && !keepManual ? null : new Set(moved.map((p) => p.id)), count: moved.length }
  }, [scope, photo, seq, range, photos, keepManual])
  useEffect(() => {
    onPreviewIds(preview.ids)
  }, [preview, onPreviewIds])
  useEffect(() => () => onPreviewIds(null), [onPreviewIds])
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
          t('sync.notice', {
            offset: fmt(offset),
            n: r.changed,
            kept: r.kept_manual ? t('sync.notice.kept', { n: r.kept_manual }) : '',
            uncovered: r.uncovered ? t('sync.notice.uncovered', { n: r.uncovered }) : '',
          }),
        )
      }, (e) => onError(e.message))
  }

  return (
    <div className="sync">
      <GpxSection projectId={projectId} gpx={gpx} onChanged={onGpx} onSnap={onGpxSnap} onError={onError} />
      {photo ? (
        <>
          <Viewer360 thumbUrl={api.thumbUrl(projectId, photo.id)} imageUrl={api.imageUrl(projectId, photo.id)} alt={photo.filename} height={260} yaw={photo.yaw_offset} pitch={photo.pitch_orig} roll={photo.roll_orig} onView={onView} />
          <div className="photo-title">
            <strong>{photo.filename}</strong>
            <span className="muted">
              {photo.idx + 1} / {photos.length}
            </span>
          </div>
        </>
      ) : (
        <p className="muted">{t('sync.choose')}</p>
      )}
      <ol className="small-text sync-help">
        <li>{t('sync.help1')}</li>
        <li>{rich(t('sync.help2'))}</li>
        <li>{t('sync.help3')}</li>
      </ol>

      <div className="sync-offset">
        <span>{t('sync.offset')}</span>
        <strong className="big">{offset == null ? '—' : fmt(offset)}</strong>
        <input
          type="range"
          min={-5}
          max={10}
          step={0.1}
          value={offset ?? 0}
          onChange={(e) => onOffset(Number(e.target.value))}
          aria-label={t('sync.offsetSeconds')}
        />
        <input
          className="num"
          type="number"
          step={0.1}
          value={offset ?? ''}
          onChange={(e) => onOffset(e.target.value === '' ? null : Number(e.target.value))}
          aria-label={t('sync.offsetLabel')}
        />
      </div>
      {lastApplied != null && <div className="small-text muted">{t('sync.lastApplied', { offset: fmt(lastApplied) })}</div>}

      <div className="row wrap">
        <button
          className="small"
          disabled={!dragged}
          title={dragged ? '' : t('sync.dragFirst')}
          onClick={() =>
            dragged && savePoints([...points.filter((p) => p.photo_id !== dragged.photoId), { photo_id: dragged.photoId, offset_s: dragged.offset }])
          }
        >
          {dragged ? t('sync.addPointPhoto', { n: (idxOf(dragged.photoId) ?? -1) + 1, offset: fmt(dragged.offset) }) : t('sync.addPoint')}
        </button>
        {med != null && (
          <button className="small" onClick={() => onOffset(Math.round(med * 10) / 10)}>
            {t('sync.useMedian', { offset: fmt(med), scope: scoped.length < points.length ? t('sync.medianScope', { n: scoped.length }) : '' })}
          </button>
        )}
      </div>
      {points.length > 0 && (
        <>
          <h3>{t('sync.points', { n: points.length })}</h3>
          {points.length > 1 && (
            <p className={`small-text ${spread > 1 ? 'warn-text' : 'muted'}`}>
              {t('sync.spread', { spread: spread.toFixed(1), warn: spread > 1 ? t('sync.spreadWarn') : '' })}
            </p>
          )}
          <ul className="sync-points small-text">
            {points.map((p) => (
              <li key={p.photo_id}>
                <button className="link" onClick={() => idxOf(p.photo_id) != null && onGo(idxOf(p.photo_id) as number)}>
                  {t('sync.pointPhoto', { n: (idxOf(p.photo_id) ?? -1) + 1 })}
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

      {runs.some((r) => r.offset_s != null) && (
        <>
          <h3>{t('sync.runs')}</h3>
          <ul className="sync-runs small-text">
            {runs.map((r) => {
              const here = photo != null && photo.idx >= r.start_idx && photo.idx <= r.end_idx
              return (
                <li key={r.start_idx} className={here ? 'current' : ''}>
                  <span>
                    {t('sync.runPhotos', { a: r.start_idx + 1, b: r.end_idx + 1 })} <span className="muted">({r.count})</span>
                    {r.manual > 0 && <span className="muted" title={t('sync.runManualTitle')}>{t('sync.runManual', { n: r.manual })}</span>}
                  </span>
                  <span className="row">
                    {r.offset_s == null ? <span className="muted">{t('sync.notSynced')}</span> : <strong>{fmt(r.offset_s)}</strong>}
                    <button className="small" onClick={() => onGo(r.start_idx)} title={t('sync.runGoTitle')}>
                      {t('sync.view')}
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <h3>{t('sync.apply.title')}</h3>
      <fieldset className="modes small-text">
        <label>
          <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> {t('sync.scope.all')}
        </label>
        <label title={t('sync.scope.fromTitle')}>
          <input type="radio" checked={scope === 'from'} disabled={!photo} onChange={() => setScope('from')} /> {t('sync.scope.from')}
          {photo ? ` (${photo.idx + 1} → ${photos.length})` : ''}
        </label>
        <label>
          <input type="radio" checked={scope === 'sequence'} disabled={!seq} onChange={() => setScope('sequence')} /> {t('sync.scope.seq')}
          {seq ? ` (${seq.name})` : t('sync.scope.seqNone')}
        </label>
        <label>
          <input type="radio" checked={scope === 'range'} disabled={!range} onChange={() => setScope('range')} /> {t('sync.scope.range')}
          {range ? ` ${range[0] + 1} → ${range[1] + 1}` : t('sync.scope.rangeNone')}
        </label>
        <label>
          <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} /> {t('sync.keepManual')}
        </label>
      </fieldset>
      <p className="small-text muted">
        {t('sync.previewInfo', { n: preview.count })}
      </p>
      <div className="actions">
        <button className="primary" disabled={offset == null || (scope === 'sequence' && !seq) || (scope === 'range' && !range) || (scope === 'from' && !photo)} onClick={apply}>
          {t('sync.applyBtn', { offset: offset == null ? '' : fmt(offset) }).trim()}
        </button>
      </div>
      <p className="small-text muted">
        {t('sync.footer')}
      </p>
    </div>
  )
}
