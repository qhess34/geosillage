import { useEffect, useState } from 'react'
import { api, FLAG_LABELS, FLAGS, PhotoDetail, PhotoRow, Sequence, UndoState } from './api'
import { fmtCoord, fmtDistance, fmtSize, fmtTime } from './format'
import HeadingDial from './HeadingDial'
import Viewer360 from './Viewer360'
import YawRotate from './YawRotate'
import { CAP_HELP, CapOrientationDiagram, ORIENTATION_HELP } from './CapOrientation'

const POS_LABELS: Record<string, string> = {
  manual: 'manuelle',
  offset: 'décalage',
  along: 'le long du trajet',
  time: 'synchro temporelle',
  interp: 'interpolée',
  osm: 'recalée sur OSM',
  gpx: 'recalée sur la trace GPX',
}

// Great-circle distance (display only)
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

export function SeqButtons({
  current,
  seqStart,
  range,
  onStart,
  onFinish,
  big,
}: {
  current: PhotoRow | null
  seqStart: number | null
  range: [number, number] | null
  onStart: () => void
  onFinish: () => void
  big?: boolean
}) {
  const n = seqStart != null && current ? Math.abs(current.idx - seqStart) + 1 : range ? range[1] - range[0] + 1 : 0
  const buttons = (
    <>
      <button disabled={!current} onClick={onStart} title="Début de séquence sur la photo courante (D)" className={seqStart != null ? 'active' : ''}>
        ⏵ Début{seqStart != null && big ? ` (photo ${seqStart + 1})` : ''}
      </button>
      <button
        className="primary"
        disabled={!current || (seqStart == null && !range)}
        onClick={onFinish}
        title={seqStart != null || range ? 'Créer la séquence jusqu\'à la photo courante (F)' : 'Marquez d\'abord le début (D)'}
      >
        ⏹ Fin{n ? (big ? ` — ${n} photos` : ` (${n})`) : ''}
      </button>
    </>
  )
  return big ? <div className="seq-buttons big">{buttons}</div> : buttons
}

interface PhotoTabProps {
  projectId: string
  photo: PhotoDetail
  count: number
  sequences: Sequence[]
  range: [number, number] | null
  seqButtons: React.ReactNode
  onView: (yawDeg: number) => void
  onChanged: (u?: UndoState) => void
  onError: (m: string) => void
}

export default function PhotoTab({ projectId, photo, count, sequences, range, seqButtons, onView, onChanged, onError }: PhotoTabProps) {
  const [draft, setDraft] = useState<number | null>(null)
  const [typed, setTyped] = useState('')
  const [rangeValue, setRangeValue] = useState('15')
  useEffect(() => {
    setDraft(null)
    setTyped(photo.heading_final != null ? String(photo.heading_final) : '')
  }, [photo.id, photo.heading_final])
  const seq = sequences.find((s) => s.id === photo.sequence_id)
  const computedWithOffset = photo.heading_auto != null ? (photo.heading_auto + (photo.heading_offset || 0) + 360) % 360 : null
  const shown = draft ?? photo.heading_final
  const set = (v: number | null) =>
    api.setHeading(projectId, photo.id, v == null ? null : Math.round((((v % 360) + 360) % 360) * 100) / 100).then((r) => onChanged(r.undo), (e) => onError(e.message))
  const rangeOp = (mode: 'offset' | 'set' | 'clear') =>
    range &&
    api.headingRange(projectId, range[0], range[1], mode, Number(rangeValue) || 0).then((r) => onChanged(r.undo), (e) => onError(e.message))
  const [latTyped, setLatTyped] = useState('')
  const [lonTyped, setLonTyped] = useState('')
  const [east, setEast] = useState('0')
  const [north, setNorth] = useState('0')
  const [along, setAlong] = useState('3')
  useEffect(() => {
    const la = photo.lat ?? photo.lat_orig
    const lo = photo.lon ?? photo.lon_orig
    setLatTyped(la != null ? la.toFixed(7) : '')
    setLonTyped(lo != null ? lo.toFixed(7) : '')
  }, [photo.id, photo.lat, photo.lon, photo.lat_orig, photo.lon_orig])
  const setPos = (lat: number | null, lon: number | null) =>
    api.setPosition(projectId, photo.id, lat, lon).then((r) => onChanged(r.undo), (e) => onError(e.message))
  const batch = (mode: 'offset' | 'along' | 'revert') =>
    range &&
    api
      .positionsBatch(projectId, {
        start_idx: range[0],
        end_idx: range[1],
        mode,
        east_m: Number(east) || 0,
        north_m: Number(north) || 0,
        meters: Number(along) || 0,
      })
      .then((r) => onChanged(r.undo), (e) => onError(e.message))

  return (
    <div className="photo-panel">
      {photo.thumb === -1 ? (
        <div className="thumb placeholder">Image illisible</div>
      ) : (
        <Viewer360
          thumbUrl={photo.thumb === 1 ? api.thumbUrl(projectId, photo.id) : api.imageUrl(projectId, photo.id)}
          imageUrl={api.imageUrl(projectId, photo.id)}
          alt={photo.filename}
          height={280}
          yaw={photo.yaw_offset}
          pitch={photo.pitch_orig}
          roll={photo.roll_orig}
          onView={onView}
          fixLabel={range ? `Sens de déplacement (plage ${range[0] + 1}→${range[1] + 1})` : 'Fixer le sens de déplacement'}
          onFixYaw={(y) =>
            api
              .setYaw(projectId, range ? { start_idx: range[0], end_idx: range[1] } : { photo_ids: [photo.id] }, y)
              .then((r) => onChanged(r.undo), (e) => onError(e.message))
          }
          onResetYaw={() => api.setYaw(projectId, { photo_ids: [photo.id] }, null).then((r) => onChanged(r.undo), (e) => onError(e.message))}
        />
      )}
      <div className="photo-title">
        <strong>{photo.filename}</strong>
        <span className="muted">
          {photo.idx + 1} / {count}
        </span>
      </div>
      {seqButtons}
      {photo.excluded ? (
        <div className="excluded-box small-text">
          Photo exclue (hors séquences, jamais exportée).{' '}
          <button className="small" onClick={() => api.excludePhotos(projectId, { photo_ids: [photo.id] }, false).then(() => onChanged(), (e) => onError(e.message))}>
            Réintégrer (Maj+X)
          </button>
        </div>
      ) : null}
      <div className="small-text">
        {seq ? (
          <>
            Séquence <strong>{seq.name}</strong> · photo {photo.rank}/{seq.count}
          </>
        ) : (
          <span className="muted">Non classée</span>
        )}
      </div>

      <h3 title={CAP_HELP}>Cap — sens de déplacement</h3>
      <p className="small-text muted section-help">Direction dans laquelle on avance, depuis le nord (flèches de la carte et de Panoramax).</p>
      <div className="heading-box">
        <HeadingDial value={shown} computed={computedWithOffset} onChange={setDraft} onCommit={(v) => set(v)} />
        <div className="heading-info small-text">
          <div>
            Calculé : {photo.heading_auto != null ? `${photo.heading_auto.toFixed(1)}°${photo.heading_auto_state === 'stop' ? ' (à l\'arrêt : direction d\'arrivée ou de départ)' : ''}` : photo.heading_auto_state === 'uncertain' ? 'incertain (la caméra ne bouge pas)' : 'impossible'}
            {photo.heading_offset ? ` ${photo.heading_offset > 0 ? '+' : ''}${photo.heading_offset}° (décalage)` : ''}
          </div>
          <div>
            Final : <strong>{shown != null ? `${shown.toFixed(1)}°` : '—'}</strong>{' '}
            {photo.heading_manual != null &&
              (photo.path.startsWith('pnx:') && photo.heading_manual === photo.heading_exif ? (
                <span className="badge" title="Cap de la photo sur Panoramax (point de départ, envoyé seulement s'il change)">Panoramax</span>
              ) : (
                <span className="badge">manuel</span>
              ))}
            {photo.heading_stale ? <span className="badge warn-text">à revoir</span> : null}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const v = Number(typed.replace(',', '.'))
              if (typed.trim() !== '' && v >= 0 && v < 360) set(v)
            }}
          >
            <input className="num" type="number" min={0} max={359.99} step={0.01} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Cap en degrés" />
            <button className="small" type="submit">
              OK
            </button>
          </form>
          <div className="btn-group">
            {[-5, -1, 1, 5].map((d) => (
              <button key={d} className="small" disabled={shown == null} onClick={() => shown != null && set(shown + d)}>
                {d > 0 ? `+${d}` : d}°
              </button>
            ))}
          </div>
          {photo.heading_manual != null && (
            <button className="small" onClick={() => set(null)}>
              Revenir au cap calculé
            </button>
          )}
        </div>
      </div>
      <h3 title={ORIENTATION_HELP}>Orientation de la caméra</h3>
      <p className="small-text muted section-help">Où regarde le centre de l'image, par rapport au sens de déplacement (casque, caméra mal montée). Ne change pas le cap.</p>
      <div className="orientation-box small-text">
        <CapOrientationDiagram heading={shown} yaw={photo.yaw_offset} />
        <div>
          <div>
            {photo.yaw_offset ? (
              <>
                Centre de l'image à <strong>{photo.yaw_offset > 0 ? '+' : ''}{photo.yaw_offset}°</strong> du sens de déplacement
                {Math.abs(photo.yaw_offset) >= 170 ? ' (caméra à l\'envers)' : photo.yaw_offset > 0 ? ' (vers la droite)' : ' (vers la gauche)'}
              </>
            ) : (
              <>Centre de l'image <strong>dans le sens de déplacement</strong> (0°)</>
            )}
          </div>
          <div className="muted">
            <span className="cap-key blue" /> cap · <span className="cap-key orange" /> centre de l'image
          </div>
          <div className="muted">Pour la corriger : tournez la vue vers l'avant puis « 🧭 Fixer le sens de déplacement » dans la visionneuse.</div>
          {photo.yaw_offset ? (
            <button className="small" onClick={() => api.setYaw(projectId, { photo_ids: [photo.id] }, null).then((r) => onChanged(r.undo), (e) => onError(e.message))}>
              Remettre à 0°
            </button>
          ) : null}
        </div>
      </div>
      {range && (
        <section className="range-card small-text">
          <header>
            Plage {range[0] + 1} → {range[1] + 1} · {range[1] - range[0] + 1} photos
          </header>
          <div className="form-row">
            <span title={CAP_HELP}>Cap</span>
            <span>
              <input className="num" type="number" step="0.5" value={rangeValue} onChange={(e) => setRangeValue(e.target.value)} aria-label="Angle (°)" />°
              <span className="btn-group">
                <button
                  className="small"
                  onClick={() =>
                    api.headingOffset(projectId, { start_idx: range[0], end_idx: range[1] }, Number(rangeValue) || 0).then((r) => onChanged(r.undo), (e) => onError(e.message))
                  }
                  title="Décalage des caps calculés des photos de la plage (remplace le décalage précédent ; 0 le retire ; les caps manuels ne changent pas)"
                >
                  Décaler
                </button>
                <button className="small" onClick={() => rangeOp('set')} title="Même cap pour toutes les photos">
                  Fixer
                </button>
              </span>
              <button className="small" onClick={() => rangeOp('clear')} title="Caps calculés depuis la trace (les caps manuels de la plage sont oubliés)">
                Caps calculés
              </button>
            </span>
          </div>
          <div className="form-row">
            <span title={ORIENTATION_HELP}>Orientation</span>
            <YawRotate projectId={projectId} target={{ start_idx: range[0], end_idx: range[1] }} what="les photos de la plage" onDone={(u) => onChanged(u)} onError={onError} />
          </div>
        </section>
      )}

      <h3>Position</h3>
      <div className="small-text position-box">
        {photo.lat == null && (photo.lat_orig == null || (photo.flags & FLAGS.INVALID_COORD) !== 0) && (
          <div className="warn-text">
            Photo sans position : elle a été prise entre les deux photos entourées en rouge sur la carte. Touche M puis
            cliquez sur la carte pour la placer, ou{' '}
            <button
              className="link"
              onClick={() =>
                api.missingPositions(projectId).then((runs) => {
                  const run = runs.find((r) => r.ids.includes(photo.id))
                  if (!run) return
                  return api.positionsBatch(projectId, { photo_ids: run.ids, mode: 'interpolate' }).then((r) => {
                    if (!r.changed) onError('Impossible d\'interpoler : pas de photo positionnée avant et après')
                    onChanged(r.undo)
                  })
                }).catch((e) => onError(e.message))
              }
            >
              interpoler ce trou
            </button>{' '}
            entre la photo d'avant et celle d'après.
          </div>
        )}
        <div>
          Originale : <span className="mono">{fmtCoord(photo.lat_orig, photo.lon_orig)}</span>
        </div>
        {photo.pos_method ? (
          <div>
            Corrigée : <span className="mono">{fmtCoord(photo.lat, photo.lon)}</span> <span className="badge">{POS_LABELS[photo.pos_method] ?? photo.pos_method}</span>{' '}
            {photo.lat_orig != null && photo.lon != null && photo.lat != null && photo.lon_orig != null && (
              <span className="muted">({fmtDistance(distanceM(photo.lat_orig, photo.lon_orig, photo.lat, photo.lon))})</span>
            )}
          </div>
        ) : (
          <div className="muted">Pas de correction. Touche M puis glisser le marqueur violet sur la carte.</div>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            const la = Number(latTyped.replace(',', '.'))
            const lo = Number(lonTyped.replace(',', '.'))
            if (latTyped && lonTyped && Number.isFinite(la) && Number.isFinite(lo)) setPos(la, lo)
          }}
        >
          <input className="coord" value={latTyped} onChange={(e) => setLatTyped(e.target.value)} placeholder="latitude" aria-label="Latitude" />
          <input className="coord" value={lonTyped} onChange={(e) => setLonTyped(e.target.value)} placeholder="longitude" aria-label="Longitude" />
          <button className="small" type="submit">
            OK
          </button>
        </form>
        <div className="row wrap">
          {photo.pos_method && (
            <button className="small" onClick={() => setPos(null, null)}>
              Revenir à la position d'origine
            </button>
          )}
        </div>
      </div>
      {range && (
        <section className="range-card small-text">
          <header>
            Positions de la plage {range[0] + 1} → {range[1] + 1}
          </header>
          <div className="form-row">
            <span>Décaler</span>
            <span>
              E <input className="num" type="number" step="0.5" value={east} onChange={(e) => setEast(e.target.value)} aria-label="Est (m)" /> m · N{' '}
              <input className="num" type="number" step="0.5" value={north} onChange={(e) => setNorth(e.target.value)} aria-label="Nord (m)" /> m
              <button className="small" onClick={() => batch('offset')} title="Déplace toutes les photos de la plage du même vecteur">
                Décaler
              </button>
            </span>
          </div>
          <div className="form-row">
            <span>Le long du trajet</span>
            <span>
              <input className="num" type="number" step="0.5" value={along} onChange={(e) => setAlong(e.target.value)} aria-label="Distance (m)" /> m
              <button className="small" onClick={() => batch('along')} title="Avance (valeur positive) ou recule chaque photo dans son sens de déplacement">
                Avancer / reculer
              </button>
            </span>
          </div>
          <div className="form-row">
            <span />
            <span>
              <button className="small" onClick={() => batch('revert')}>
                Revenir aux positions d'origine
              </button>
            </span>
          </div>
        </section>
      )}

      <h3>Informations</h3>
      <table className="summary">
        <tbody>
          <tr>
            <th>Date</th>
            <td>{photo.ts_text ?? '—'}</td>
          </tr>
          <tr>
            <th>Heure GPS</th>
            <td>{fmtTime(photo.gps_ts)}</td>
          </tr>
          <tr>
            <th>Cap EXIF</th>
            <td>{photo.heading_exif != null ? `${photo.heading_exif}°` : 'absent'}</td>
          </tr>
          <tr>
            <th>Caméra</th>
            <td>
              {photo.make} {photo.model} {photo.is_360 ? '· 360°' : ''}
            </td>
          </tr>
          <tr>
            <th>Image</th>
            <td>
              {photo.width}×{photo.height} · {fmtSize(photo.size)}
            </td>
          </tr>
          <tr>
            <th>Fichier</th>
            <td className="mono small-text break">{photo.path}</td>
          </tr>
        </tbody>
      </table>
      {photo.flag_names.length > 0 && (
        <ul className="flags">
          {photo.flag_names.map((f) => (
            <li key={f}>{FLAG_LABELS[f] ?? f}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
