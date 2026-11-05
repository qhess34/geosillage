import { useEffect, useMemo, useState } from 'react'
import { api, PhotoRow, SnapProposal, UndoState } from './api'

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
export default function OsmSnapPanel({
  projectId,
  range,
  photos,
  onPreview,
  onDone,
  onClose,
  onError,
}: {
  projectId: string
  range: [number, number]
  photos: PhotoRow[]
  onPreview: (p: SnapPreview | null) => void
  onDone: (u: UndoState, moved: number) => void
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [prop, setProp] = useState<SnapProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [choices, setChoices] = useState<(number | null)[]>([])
  const [hover, setHover] = useState<number | null>(null)
  const [keepManual, setKeepManual] = useState(true)

  useEffect(() => {
    setLoading(true)
    setProp(null)
    api.snapPropose(projectId, range[0], range[1]).then(
      (p) => {
        setProp(p)
        setChoices(p.segments.map((s) => (s.status === 'clear' ? s.way_id : null)))
        setLoading(false)
      },
      (e) => {
        setLoading(false)
        onError(e.message)
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, range[0], range[1]])

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
    if (!prop) return
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
    <div className="snap-panel small-text">
      <div className="row between">
        <h3>
          Recalage sur OpenStreetMap · photos {range[0] + 1} → {range[1] + 1}
        </h3>
        <button className="small" onClick={onClose} aria-label="Fermer">
          ✕
        </button>
      </div>
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
