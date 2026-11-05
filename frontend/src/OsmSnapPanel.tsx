import { useEffect, useMemo, useRef, useState } from 'react'
import { api, PhotoRow, Sequence, SnapProposal, UndoState } from './api'

export interface SnapPreview {
  ways: GeoJSON.FeatureCollection // candidate ways (property chosen = 1 for a way that will be used)
  moves: GeoJSON.FeatureCollection // current position → snapped position, for the photos that will move
  highlight: number | null // way hovered in the list
}

const HIGHWAY_LABELS: Record<string, string> = {
  cycleway: 'piste cyclable',
  path: 'chemin',
  track: 'piste',
  footway: 'voie piétonne',
  pedestrian: 'zone piétonne',
  living_street: 'zone de rencontre',
  residential: 'rue',
  service: 'voie de service',
  unclassified: 'route',
  tertiary: 'route',
  secondary: 'route',
  primary: 'route principale',
  trunk: 'voie rapide',
  steps: 'escalier',
  bridleway: 'chemin',
}

function wayLabel(w: { name: string; highway: string }): string {
  const kind = HIGHWAY_LABELS[w.highway] ?? w.highway
  return w.name ? `${w.name} (${kind})` : kind.charAt(0).toUpperCase() + kind.slice(1) + ' sans nom'
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
  const [prop, setProp] = useState<SnapProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [choices, setChoices] = useState<(number | null)[]>([])
  const [hover, setHover] = useState<number | null>(null)
  const [keepManual, setKeepManual] = useState(true)
  const [scope, setScope] = useState<SnapScope>(initialScope)
  const box = useRef<HTMLDivElement>(null)
  // the window can be moved by its title bar (kept inside the map area)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent) => {
    const el = box.current
    if (!drag.current || !el || !(e.buttons & 1)) return
    const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect()
    if (!parent) return
    const left = Math.max(0, Math.min(parent.width - 80, e.clientX - parent.left - drag.current.dx))
    const top = Math.max(0, Math.min(parent.height - 40, e.clientY - parent.top - drag.current.dy))
    setPos({ left, top })
  }
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
      const t = e.target as HTMLElement
      if (t?.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return
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
    const t = window.setTimeout(
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
      window.clearTimeout(t)
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
      aria-label="Recalage sur OpenStreetMap"
      style={pos ? { left: pos.left, top: pos.top, right: 'auto' } : undefined}
    >
      <div
        className="row between snap-title"
        title="Faire glisser pour déplacer la fenêtre"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => (drag.current = null)}
      >
        <h3>Recalage sur OpenStreetMap{range ? ` · photos ${range[0] + 1} → ${range[1] + 1}` : ''}</h3>
        <button className="small" onClick={onClose} aria-label="Fermer">
          ✕
        </button>
      </div>
      <fieldset className="modes">
        <legend>Photos à recaler (D / F : début / fin de la sélection, sans toucher aux séquences)</legend>
        <label>
          <input type="radio" checked={scope === 'sequence'} disabled={!seq} onChange={() => setScope('sequence')} /> Séquence{' '}
          {seq ? `« ${seq.name} » (${seq.start_idx + 1} → ${seq.end_idx + 1})` : '(photo non classée)'}
        </label>
        <label>
          <input type="radio" checked={scope === 'timeline'} disabled={!timelineRange} onChange={() => setScope('timeline')} /> Plage de la
          timeline {timelineRange ? `(${timelineRange[0] + 1} → ${timelineRange[1] + 1})` : '(glisser sur la timeline, ou Maj+clic)'}
        </label>
        <label>
          <input type="radio" checked={scope === 'custom'} onChange={() => setScope('custom')} /> Photos{' '}
          {bounds[0] != null ? bounds[0] + 1 : '…'} → {bounds[1] != null ? bounds[1] + 1 : '…'}
        </label>
        {scope === 'custom' && (
          <div className="row wrap">
            <button className="small" disabled={!current} onClick={() => current && setBounds([current.idx, bounds[1]])}>
              De cette photo{current ? ` (${current.idx + 1})` : ''}
            </button>
            <button className="small" disabled={!current} onClick={() => current && setBounds([bounds[0], current.idx])}>
              Jusqu'à cette photo{current ? ` (${current.idx + 1})` : ''}
            </button>
            <span className="muted">ou D sur la première photo, ← →, puis F sur la dernière{following ? ' (en cours…)' : ''}</span>
          </div>
        )}
      </fieldset>
      {loading && <p className="muted">Recherche des voies OpenStreetMap autour de la sélection…</p>}
      {prop && prop.segments.length === 0 && <p className="muted">Aucune photo positionnée dans la sélection.</p>}
      {prop && prop.segments.length > 0 && (
        <>
          <p className="muted">
            Chaque tronçon est placé sur la voie choisie (aperçu sur la carte : la voie en bleu foncé, les déplacements en
            pointillés). Quand plusieurs voies sont à distance comparable, choisissez celle que vous avez prise. Annulable
            (Ctrl+Z).
          </p>
          <ol className="snap-list">
            {prop.segments.map((s, i) => (
              <li key={s.start_idx} className={s.status}>
                <div>
                  <strong>
                    {s.count > 1 ? `Photos ${s.start_idx + 1} → ${s.end_idx + 1}` : `Photo ${s.start_idx + 1}`}
                  </strong>{' '}
                  <span className="muted">({s.count})</span>
                  {s.status === 'none' && <span className="muted"> · aucune voie à moins de 15 m : laissé tel quel</span>}
                  {s.status === 'ambiguous' && <span className="warn-text"> · plusieurs voies possibles : à choisir</span>}
                </div>
                {s.status !== 'none' &&
                  (s.status === 'clear' ? (
                    <label onMouseEnter={() => setHover(s.candidates[0].id)} onMouseLeave={() => setHover(null)}>
                      <input
                        type="checkbox"
                        checked={choices[i] != null}
                        onChange={(e) => setChoices(choices.map((c, j) => (j === i ? (e.target.checked ? s.candidates[0].id : null) : c)))}
                      />{' '}
                      {wayLabel(s.candidates[0])} <span className="muted">· {s.candidates[0].mean_dist} m en moyenne</span>
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
                          {wayLabel(c)} <span className="muted">· {c.mean_dist} m</span>
                        </label>
                      ))}
                      <label>
                        <input
                          type="radio"
                          name={`snap-${s.start_idx}`}
                          checked={choices[i] == null}
                          onChange={() => setChoices(choices.map((x, j) => (j === i ? null : x)))}
                        />{' '}
                        Ne pas recaler ce tronçon
                      </label>
                    </div>
                  ))}
              </li>
            ))}
          </ol>
          {manual.size > 0 && (
            <label>
              <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} /> Garder les {manual.size} photo(s)
              placée(s) à la main
            </label>
          )}
          <div className="row wrap">
            <button className="primary small" disabled={!moving.length} onClick={apply}>
              Recaler {moving.length} photo(s)
            </button>
            {ambiguousLeft > 0 && <span className="warn-text">{ambiguousLeft} tronçon(s) ambigu(s) sans voie choisie : ils ne bougeront pas</span>}
          </div>
        </>
      )}
    </div>
  )
}
