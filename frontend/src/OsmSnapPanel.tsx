import { useEffect, useMemo, useRef, useState } from 'react'
import { useDraggable } from './useDraggable'
import { api, PhotoRow, Sequence, SnapProposal, UndoState } from './api'
import { Key, t, useLang } from './i18n'

export interface SnapPreview {
  ways: GeoJSON.FeatureCollection // candidate ways (property chosen = 1 for a way that will be used)
  moves: GeoJSON.FeatureCollection // current position → snapped position, for the photos that will move
  highlight: number | null // way hovered in the list
}

const HIGHWAYS = ['cycleway', 'path', 'track', 'footway', 'pedestrian', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'steps', 'bridleway']

// OSM name shown as is (never translated); the kind of way is
function wayLabel(w: { name: string; highway: string }): string {
  const kind = HIGHWAYS.includes(w.highway) ? t(`hw.${w.highway}` as Key) : w.highway
  return w.name ? `${w.name} (${kind})` : t('osm.unnamed', { kind, Kind: kind.charAt(0).toUpperCase() + kind.slice(1) })
}

// Snapping a selection onto OpenStreetMap ways: segments proposed by the server, the user picks the way of each
// ambiguous segment, preview on the map, then one undoable operation
// What is snapped: independent of the cut of the sequences (D / F are never used here)
export type SnapScope = 'sequence' | 'timeline' | 'custom'

export default function OsmSnapPanel({
  projectId,
  initialScope,
  initialBounds,
  sequenceId,
  timelineRange,
  current,
  sequences,
  photos,
  onPreview,
  onRange,
  onDone,
  onClose,
  onError,
}: {
  projectId: string
  initialScope: SnapScope
  initialBounds?: [number, number] | null // photos chosen when opening (custom scope)
  sequenceId: number | null // sequence of the photo when the panel was opened
  timelineRange: [number, number] | null // range drawn on the timeline (drag / Shift+click)
  current: PhotoRow | null
  sequences: Sequence[]
  photos: PhotoRow[]
  onPreview: (p: SnapPreview | null) => void
  onRange: (r: [number, number] | null) => void // photos concerned: highlighted on the map and the timeline
  onDone: (u: UndoState, moved: number) => void
  onClose: () => void
  onError: (msg: string) => void
}) {
  useLang()
  const [prop, setProp] = useState<SnapProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [choices, setChoices] = useState<(number | null)[]>([])
  const [hover, setHover] = useState<number | null>(null)
  const [keepManual, setKeepManual] = useState(true)
  const [scope, setScope] = useState<SnapScope>(initialScope)
  // the window can be moved by its title bar (kept inside the map area)
  const { box, style: boxStyle, handlers: dragHandlers } = useDraggable<HTMLDivElement>()
  const [bounds, setBounds] = useState<[number | null, number | null]>(initialBounds ?? [current?.idx ?? null, null])
  // after D, the end follows the navigation (← →) until F, as for a sequence — but nothing is cut here
  const [following, setFollowing] = useState(false)
  const cur = useRef(current)
  cur.current = current
  useEffect(() => {
    if (following && current) setBounds((b) => [b[0], current.idx])
  }, [following, current])
  // Keys while the window is open: Escape closes it; D / F choose the photos to snap (instead of cutting a sequence)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el?.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') onClose()
      else if (k === 'd' && cur.current) {
        setScope('custom')
        setBounds([cur.current.idx, cur.current.idx])
        setFollowing(true)
      } else if (k === 'f' && cur.current) {
        setScope('custom')
        setBounds((b) => [b[0] ?? cur.current!.idx, cur.current!.idx])
        setFollowing(false)
      } else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const seq = sequences.find((x) => x.id === sequenceId) ?? null
  const range: [number, number] | null =
    scope === 'sequence'
      ? seq && [seq.start_idx, seq.end_idx]
      : scope === 'timeline'
        ? timelineRange
        : bounds[0] != null && bounds[1] != null
          ? [Math.min(bounds[0], bounds[1]), Math.max(bounds[0], bounds[1])]
          : null
  const rangeKey = range ? `${range[0]}-${range[1]}` : ''
  useEffect(() => {
    onRange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey])
  useEffect(() => () => onRange(null), [onRange])

  useEffect(() => {
    setProp(null)
    onPreview(null)
    if (!range) {
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = window.setTimeout(
      () =>
        api.snapPropose(projectId, range[0], range[1]).then(
          (p) => {
            if (cancelled) return
            setProp(p)
            setChoices(p.segments.map((s) => (s.status === 'clear' ? s.way_id : null)))
            setLoading(false)
          },
          (e) => {
            if (cancelled) return
            setLoading(false)
            onError(e.message)
          },
        ),
      following ? 500 : 0, // while the range follows ← →: one request once the navigation pauses
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rangeKey])

  const manual = useMemo(() => new Set(prop?.manual_ids ?? []), [prop])
  const moving = useMemo(() => {
    if (!prop) return []
    const out: { id: number; from: [number, number]; to: [number, number] }[] = []
    prop.segments.forEach((s, i) => {
      const w = choices[i]
      if (w == null) return
      for (const p of photos) {
        if (p.idx < s.start_idx || p.idx > s.end_idx || p.lat == null || p.lon == null) continue
        if (keepManual && manual.has(p.id)) continue
        const c = prop.projections[p.id]?.[w]
        if (c) out.push({ id: p.id, from: [p.lon, p.lat], to: [c[1], c[0]] })
      }
    })
    return out
  }, [prop, choices, photos, keepManual, manual])

  useEffect(() => {
    if (!prop) return
    const chosen = new Set(choices.filter((c): c is number => c != null))
    onPreview({
      ways: {
        type: 'FeatureCollection',
        features: prop.ways.map((w) => ({
          type: 'Feature',
          properties: { id: w.id, chosen: chosen.has(w.id) ? 1 : 0 },
          geometry: { type: 'LineString', coordinates: w.coords.map(([la, lo]) => [lo, la]) },
        })),
      },
      moves: {
        type: 'FeatureCollection',
        features: moving.flatMap((m) => [
          { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [m.from, m.to] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: m.to } },
        ]),
      },
      highlight: hover,
    })
  }, [prop, choices, moving, hover, onPreview])

  // the preview disappears with the panel
  useEffect(() => () => onPreview(null), [onPreview])

  const apply = () => {
    if (!prop || !range) return
    const segments = prop.segments
      .map((s, i) => ({ start_idx: s.start_idx, end_idx: s.end_idx, way_id: choices[i] }))
      .filter((s): s is { start_idx: number; end_idx: number; way_id: number } => s.way_id != null)
    if (!segments.length) return
    api.snapApply(projectId, { start_idx: range[0], end_idx: range[1], segments, keep_manual: keepManual }).then(
      (r) => onDone(r.undo, r.moved),
      (e) => onError(e.message),
    )
  }

  const ambiguousLeft = prop ? prop.segments.filter((s, i) => s.status === 'ambiguous' && choices[i] == null).length : 0

  return (
    <div
      className="snap-panel snap-modal small-text"
      ref={box}
      role="dialog"
      aria-label={t('osm.title')}
      style={boxStyle}
    >
      <div
        className="row between snap-title"
        title={t('gpx.snap.drag')}
        {...dragHandlers}
      >
        <h3>{range ? t('osm.titleRange', { a: range[0] + 1, b: range[1] + 1 }) : t('osm.title')}</h3>
        <button className="small" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>
      <fieldset className="modes">
        <legend>{t('osm.photosTo')}</legend>
        <label>
          <input type="radio" checked={scope === 'sequence'} disabled={!seq} onChange={() => setScope('sequence')} /> {t('osm.scope.seq')}{' '}
          {seq ? `« ${seq.name} » (${seq.start_idx + 1} → ${seq.end_idx + 1})` : t('osm.scope.seqNone')}
        </label>
        <label>
          <input type="radio" checked={scope === 'timeline'} disabled={!timelineRange} onChange={() => setScope('timeline')} /> {t('osm.scope.timeline')}{' '}
          {timelineRange ? `(${timelineRange[0] + 1} → ${timelineRange[1] + 1})` : t('osm.scope.timelineNone')}
        </label>
        <label>
          <input type="radio" checked={scope === 'custom'} onChange={() => setScope('custom')} /> {t('osm.scope.custom')}{' '}
          {bounds[0] != null ? bounds[0] + 1 : '…'} → {bounds[1] != null ? bounds[1] + 1 : '…'}
        </label>
        {scope === 'custom' && (
          <div className="row wrap">
            <button className="small" disabled={!current} onClick={() => current && setBounds([current.idx, bounds[1]])}>
              {t('osm.from', { n: current ? ` (${current.idx + 1})` : '' })}
            </button>
            <button className="small" disabled={!current} onClick={() => current && setBounds([bounds[0], current.idx])}>
              {t('osm.until', { n: current ? ` (${current.idx + 1})` : '' })}
            </button>
            <span className="muted">{t('osm.orKeys', { running: following ? t('osm.running') : '' })}</span>
          </div>
        )}
      </fieldset>
      {loading && <p className="muted">{t('osm.searching')}</p>}
      {prop && prop.segments.length === 0 && <p className="muted">{t('osm.noPhoto')}</p>}
      {prop && prop.segments.length > 0 && (
        <>
          <p className="muted">
            {t('osm.help')}
          </p>
          <ol className="snap-list">
            {prop.segments.map((s, i) => (
              <li key={s.start_idx} className={s.status}>
                <div>
                  <strong>
                    {s.count > 1 ? t('osm.seg.photos', { a: s.start_idx + 1, b: s.end_idx + 1 }) : t('osm.seg.photo', { a: s.start_idx + 1 })}
                  </strong>{' '}
                  <span className="muted">({s.count})</span>
                  {s.status === 'none' && <span className="muted">{t('osm.seg.none')}</span>}
                  {s.status === 'ambiguous' && <span className="warn-text">{t('osm.seg.ambiguous')}</span>}
                </div>
                {s.status !== 'none' &&
                  (s.status === 'clear' ? (
                    <label onMouseEnter={() => setHover(s.candidates[0].id)} onMouseLeave={() => setHover(null)}>
                      <input
                        type="checkbox"
                        checked={choices[i] != null}
                        onChange={(e) => setChoices(choices.map((c, j) => (j === i ? (e.target.checked ? s.candidates[0].id : null) : c)))}
                      />{' '}
                      {wayLabel(s.candidates[0])} <span className="muted">{t('osm.meanDist', { d: s.candidates[0].mean_dist })}</span>
                    </label>
                  ) : (
                    <div className="snap-choices">
                      {s.candidates.map((c) => (
                        <label key={c.id} onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)}>
                          <input
                            type="radio"
                            name={`snap-${s.start_idx}`}
                            checked={choices[i] === c.id}
                            onChange={() => setChoices(choices.map((x, j) => (j === i ? c.id : x)))}
                          />{' '}
                          {wayLabel(c)} <span className="muted">{t('osm.dist', { d: c.mean_dist })}</span>
                        </label>
                      ))}
                      <label>
                        <input
                          type="radio"
                          name={`snap-${s.start_idx}`}
                          checked={choices[i] == null}
                          onChange={() => setChoices(choices.map((x, j) => (j === i ? null : x)))}
                        />{' '}
                        {t('osm.skip')}
                      </label>
                    </div>
                  ))}
              </li>
            ))}
          </ol>
          {manual.size > 0 && (
            <label>
              <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} /> {t('osm.keepManual', { n: manual.size })}
            </label>
          )}
          <div className="row wrap">
            <button className="primary small" disabled={!moving.length} onClick={apply}>
              {t('osm.apply', { n: moving.length })}
            </button>
            {ambiguousLeft > 0 && <span className="warn-text">{t('osm.ambiguousLeft', { n: ambiguousLeft })}</span>}
          </div>
        </>
      )}
    </div>
  )
}
