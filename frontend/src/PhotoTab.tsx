import { useEffect, useState } from 'react'
import { api, FLAGS, PhotoDetail, PhotoRow, Sequence, UndoState } from './api'
import { fmtCoord, fmtDistance, fmtSize, fmtTime } from './format'
import HeadingDial from './HeadingDial'
import Viewer360 from './Viewer360'
import YawRotate from './YawRotate'
import { capHelp, CapOrientationDiagram, orientationHelp } from './CapOrientation'
import { Key, rich, t, useLang } from './i18n'

const POS_KEYS = ['manual', 'offset', 'along', 'time', 'interp', 'osm', 'gpx']
const posLabel = (m: string) => (POS_KEYS.includes(m) ? t(`pos.${m}` as Key) : m)
const FLAG_KEYS = ['no_gps', 'no_date', 'duplicate', 'invalid_coord', 'gps_jump', 'gap_before', 'unreadable', 'same_time', 'missing_file']
const flagLabel = (f: string) => (FLAG_KEYS.includes(f) ? t(`flag.${f}` as Key) : f)

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
  useLang()
  const n = seqStart != null && current ? Math.abs(current.idx - seqStart) + 1 : range ? range[1] - range[0] + 1 : 0
  const buttons = (
    <>
      <button disabled={!current} onClick={onStart} title={t('photo.seqStartTitle')} className={seqStart != null ? 'active' : ''}>
        {t('photo.start')}{seqStart != null && big ? t('photo.startAt', { n: seqStart + 1 }) : ''}
      </button>
      <button
        className="primary"
        disabled={!current || (seqStart == null && !range)}
        onClick={onFinish}
        title={seqStart != null || range ? t('photo.finishTitle') : t('photo.markStartFirst')}
      >
        {t('photo.end')}{n ? (big ? t('photo.endBig', { n }) : ` (${n})`) : ''}
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
  useLang()
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
        <div className="thumb placeholder">{t('photo.unreadable')}</div>
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
          fixLabel={range ? t('photo.fixRange', { a: range[0] + 1, b: range[1] + 1 }) : t('photo.fix')}
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
          {t('photo.excluded')}{' '}
          <button className="small" onClick={() => api.excludePhotos(projectId, { photo_ids: [photo.id] }, false).then(() => onChanged(), (e) => onError(e.message))}>
            {t('photo.reinclude')}
          </button>
        </div>
      ) : null}
      <div className="small-text">
        {seq ? (
          <>{rich(t('photo.sequence', { name: seq.name, rank: photo.rank ?? '', count: seq.count }))}</>
        ) : (
          <span className="muted">{t('photo.unclassified')}</span>
        )}
      </div>

      <h3 title={capHelp()}>{t('photo.heading.title')}</h3>
      <p className="small-text muted section-help">{t('photo.heading.help')}</p>
      <div className="heading-box">
        <HeadingDial value={shown} computed={computedWithOffset} onChange={setDraft} onCommit={(v) => set(v)} />
        <div className="heading-info small-text">
          <div>
            {t('photo.computed', {
              value:
                photo.heading_auto != null
                  ? `${photo.heading_auto.toFixed(1)}°${photo.heading_auto_state === 'stop' ? t('photo.computedStop') : ''}`
                  : photo.heading_auto_state === 'uncertain'
                    ? t('photo.computedUncertain')
                    : t('photo.computedNone'),
              offset: photo.heading_offset ? t('photo.computedOffset', { value: `${photo.heading_offset > 0 ? '+' : ''}${photo.heading_offset}` }) : '',
            })}
          </div>
          <div>
            {t('photo.final')} <strong>{shown != null ? `${shown.toFixed(1)}°` : '—'}</strong>{' '}
            {photo.heading_manual != null &&
              (photo.path.startsWith('pnx:') && photo.heading_manual === photo.heading_exif ? (
                <span className="badge" title={t('photo.pnxHeadingTitle')}>Panoramax</span>
              ) : (
                <span className="badge">{t('photo.manual')}</span>
              ))}
            {photo.heading_stale ? <span className="badge warn-text">{t('photo.review')}</span> : null}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const v = Number(typed.replace(',', '.'))
              if (typed.trim() !== '' && v >= 0 && v < 360) set(v)
            }}
          >
            <input className="num" type="number" min={0} max={359.99} step={0.01} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t('photo.headingDeg')} />
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
              {t('photo.backToComputed')}
            </button>
          )}
        </div>
      </div>
      <h3 title={orientationHelp()}>{t('photo.orient.title')}</h3>
      <p className="small-text muted section-help">{t('photo.orient.help')}</p>
      <div className="orientation-box small-text">
        <CapOrientationDiagram heading={shown} yaw={photo.yaw_offset} />
        <div>
          <div>
            {photo.yaw_offset ? (
              <>
                {rich(t('photo.orient.at', { value: `${photo.yaw_offset > 0 ? '+' : ''}${photo.yaw_offset}` }))}
                {Math.abs(photo.yaw_offset) >= 170 ? t('photo.orient.upside') : photo.yaw_offset > 0 ? t('photo.orient.right') : t('photo.orient.left')}
              </>
            ) : (
              <>{rich(t('photo.orient.zero'))}</>
            )}
          </div>
          <div className="muted">
            <span className="cap-key blue" /> {t('photo.orient.keyHeading')} · <span className="cap-key orange" /> {t('photo.orient.keyCentre')}
          </div>
          <div className="muted">{t('photo.orient.fixHelp')}</div>
          {photo.yaw_offset ? (
            <button className="small" onClick={() => api.setYaw(projectId, { photo_ids: [photo.id] }, null).then((r) => onChanged(r.undo), (e) => onError(e.message))}>
              {t('photo.orient.reset')}
            </button>
          ) : null}
        </div>
      </div>
      {range && (
        <section className="range-card small-text">
          <header>
            {t('photo.range.header', { a: range[0] + 1, b: range[1] + 1, n: range[1] - range[0] + 1 })}
          </header>
          <div className="form-row">
            <span title={capHelp()}>{t('photo.range.heading')}</span>
            <span>
              <input className="num" type="number" step="0.5" value={rangeValue} onChange={(e) => setRangeValue(e.target.value)} aria-label={t('photo.range.angle')} />°
              <span className="btn-group">
                <button
                  className="small"
                  onClick={() =>
                    api.headingOffset(projectId, { start_idx: range[0], end_idx: range[1] }, Number(rangeValue) || 0).then((r) => onChanged(r.undo), (e) => onError(e.message))
                  }
                  title={t('photo.range.shiftTitle')}
                >
                  {t('photo.range.shift')}
                </button>
                <button className="small" onClick={() => rangeOp('set')} title={t('photo.range.setTitle')}>
                  {t('photo.range.set')}
                </button>
              </span>
              <button className="small" onClick={() => rangeOp('clear')} title={t('photo.range.clearTitle')}>
                {t('photo.range.clear')}
              </button>
            </span>
          </div>
          <div className="form-row">
            <span title={orientationHelp()}>{t('photo.range.orientation')}</span>
            <YawRotate projectId={projectId} target={{ start_idx: range[0], end_idx: range[1] }} what={t('yaw.what.range')} onDone={(u) => onChanged(u)} onError={onError} />
          </div>
        </section>
      )}

      <h3>{t('photo.position')}</h3>
      <div className="small-text position-box">
        {photo.lat == null && (photo.lat_orig == null || (photo.flags & FLAGS.INVALID_COORD) !== 0) && (
          <div className="warn-text">
            {t('photo.noPos')}{' '}
            <button
              className="link"
              onClick={() =>
                api.missingPositions(projectId).then((runs) => {
                  const run = runs.find((r) => r.ids.includes(photo.id))
                  if (!run) return
                  return api.positionsBatch(projectId, { photo_ids: run.ids, mode: 'interpolate' }).then((r) => {
                    if (!r.changed) onError(t('photo.cannotInterpolate'))
                    onChanged(r.undo)
                  })
                }).catch((e) => onError(e.message))
              }
            >
              {t('photo.interpolate')}
            </button>{' '}
            {t('photo.noPosEnd')}
          </div>
        )}
        <div>
          {t('photo.original')} <span className="mono">{fmtCoord(photo.lat_orig, photo.lon_orig)}</span>
        </div>
        {photo.pos_method ? (
          <div>
            {t('photo.corrected')} <span className="mono">{fmtCoord(photo.lat, photo.lon)}</span> <span className="badge">{posLabel(photo.pos_method)}</span>{' '}
            {photo.lat_orig != null && photo.lon != null && photo.lat != null && photo.lon_orig != null && (
              <span className="muted">({fmtDistance(distanceM(photo.lat_orig, photo.lon_orig, photo.lat, photo.lon))})</span>
            )}
          </div>
        ) : (
          <div className="muted">{t('photo.noCorrection')}</div>
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
          <input className="coord" value={latTyped} onChange={(e) => setLatTyped(e.target.value)} placeholder={t('photo.latitude')} aria-label={t('photo.latitude')} />
          <input className="coord" value={lonTyped} onChange={(e) => setLonTyped(e.target.value)} placeholder={t('photo.longitude')} aria-label={t('photo.longitude')} />
          <button className="small" type="submit">
            OK
          </button>
        </form>
        <div className="row wrap">
          {photo.pos_method && (
            <button className="small" onClick={() => setPos(null, null)}>
              {t('photo.revertPos')}
            </button>
          )}
        </div>
      </div>
      {range && (
        <section className="range-card small-text">
          <header>
            {t('photo.posRange', { a: range[0] + 1, b: range[1] + 1 })}
          </header>
          <div className="form-row">
            <span>{t('photo.range.shift')}</span>
            <span>
              E <input className="num" type="number" step="0.5" value={east} onChange={(e) => setEast(e.target.value)} aria-label={t('photo.east')} /> m · N{' '}
              <input className="num" type="number" step="0.5" value={north} onChange={(e) => setNorth(e.target.value)} aria-label={t('photo.north')} /> m
              <button className="small" onClick={() => batch('offset')} title={t('photo.moveAll')}>
                {t('photo.range.shift')}
              </button>
            </span>
          </div>
          <div className="form-row">
            <span>{t('photo.alongRoute')}</span>
            <span>
              <input className="num" type="number" step="0.5" value={along} onChange={(e) => setAlong(e.target.value)} aria-label={t('photo.distance')} /> m
              <button className="small" onClick={() => batch('along')} title={t('photo.alongTitle')}>
                {t('photo.alongBtn')}
              </button>
            </span>
          </div>
          <div className="form-row">
            <span />
            <span>
              <button className="small" onClick={() => batch('revert')}>
                {t('photo.revertRange')}
              </button>
            </span>
          </div>
        </section>
      )}

      <h3>{t('photo.info')}</h3>
      <table className="summary">
        <tbody>
          <tr>
            <th>{t('photo.info.date')}</th>
            <td>{photo.ts_text ?? '—'}</td>
          </tr>
          <tr>
            <th>{t('photo.info.gpsTime')}</th>
            <td>{fmtTime(photo.gps_ts)}</td>
          </tr>
          <tr>
            <th>{t('photo.info.exifHeading')}</th>
            <td>{photo.heading_exif != null ? `${photo.heading_exif}°` : t('photo.info.absent')}</td>
          </tr>
          <tr>
            <th>{t('photo.info.camera')}</th>
            <td>
              {photo.make} {photo.model} {photo.is_360 ? '· 360°' : ''}
            </td>
          </tr>
          <tr>
            <th>{t('photo.info.image')}</th>
            <td>
              {photo.width}×{photo.height} · {fmtSize(photo.size)}
            </td>
          </tr>
          <tr>
            <th>{t('photo.info.file')}</th>
            <td className="mono small-text break">{photo.path}</td>
          </tr>
        </tbody>
      </table>
      {photo.flag_names.length > 0 && (
        <ul className="flags">
          {photo.flag_names.map((f) => (
            <li key={f}>{flagLabel(f)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
