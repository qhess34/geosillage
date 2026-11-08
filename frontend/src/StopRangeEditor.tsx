import { PhotoRow } from './api'
import { fmtTime } from './format'
import { t, useLang } from './i18n'

const R = 6371008.8
const rad = Math.PI / 180
const pos = (p: PhotoRow): [number, number] | null => (p.lat != null && p.lon != null ? [p.lat, p.lon] : p.lat_orig != null && p.lon_orig != null ? [p.lat_orig, p.lon_orig] : null)
function meters(a: PhotoRow, b: PhotoRow): number | null {
  const x = pos(a)
  const y = pos(b)
  if (!x || !y) return null
  const dLat = (y[0] - x[0]) * rad
  const dLon = (y[1] - x[1]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(x[0] * rad) * Math.cos(y[0] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const AROUND = 3 // neighbours listed on each side, to add them

// Photos of a stop before comparing them: the contiguous run can be widened or narrowed (selected on the map and the
// timeline at each change); a click on a row shows that photo (map centred on it, Photo tab).
export default function StopRangeEditor({
  photos,
  range,
  currentIdx,
  onRange,
  onGo,
}: {
  photos: PhotoRow[]
  range: [number, number]
  currentIdx: number | null
  onRange: (r: [number, number]) => void
  onGo: (idx: number) => void
}) {
  useLang()
  const [s, e] = range
  const last = photos.length - 1
  const from = Math.max(0, s - AROUND)
  const to = Math.min(last, e + AROUND)
  const rows = photos.slice(from, to + 1)
  const kept = photos.slice(s, e + 1).filter((p) => !p.excluded).length
  return (
    <div className="stop-range">
      <div className="row wrap">
        <strong>
          {t('stoprange.range', { a: s + 1, b: e + 1 })}
        </strong>
        <span className="muted">
          ({e - s + 1}
          {kept < e - s + 1 ? t('stoprange.alreadyExcluded', { n: e - s + 1 - kept }) : ''})
        </span>
        <span className="spacer" />
        <span className="muted">{t('stoprange.start')}</span>
        <span className="btn-group">
          <button className="small" disabled={s === 0} onClick={() => onRange([s - 1, e])} title={t('stoprange.addPrev')}>
            ◀
          </button>
          <button className="small" disabled={s >= e} onClick={() => onRange([s + 1, e])} title={t('stoprange.removeFirst')}>
            ▶
          </button>
        </span>
        <span className="muted">{t('stoprange.end')}</span>
        <span className="btn-group">
          <button className="small" disabled={e <= s} onClick={() => onRange([s, e - 1])} title={t('stoprange.removeLast')}>
            ◀
          </button>
          <button className="small" disabled={e >= last} onClick={() => onRange([s, e + 1])} title={t('stoprange.addNext')}>
            ▶
          </button>
        </span>
      </div>
      <ul className="stop-range-list">
        {rows.map((p, k) => {
          const i = from + k
          const inside = i >= s && i <= e
          const prev = i > 0 ? photos[i - 1] : null
          const d = prev ? meters(prev, p) : null
          return (
            <li key={p.id} className={`${inside ? 'in' : 'out'}${i === currentIdx ? ' current' : ''}${p.excluded ? ' excluded' : ''}`}>
              <button className="stop-range-go" onClick={() => onGo(i)} title={t('stoprange.view')}>
                <span>{t('stoprange.photo', { n: i + 1 })}</span>
                <span className="muted">{fmtTime(p.ts, false)}</span>
                <span className="muted">{d != null ? `${d < 10 ? d.toFixed(1) : Math.round(d)} m` : ''}</span>
                {p.excluded ? <span className="muted">{t('stoprange.excluded')}</span> : null}
              </button>
              <span className="stop-range-act">
                {!inside && (
                  <button className="small" onClick={() => onRange([Math.min(s, i), Math.max(e, i)])} title={t('stoprange.addTitle')}>
                    + {t('common.add')}
                  </button>
                )}
                {inside && s < e && (i === s || i === e) && (
                  <button className="small" onClick={() => onRange(i === s ? [s + 1, e] : [s, e - 1])} title={t('stoprange.removeTitle')}>
                    − {t('common.remove')}
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="muted small-text">{t('stoprange.help')}</p>
    </div>
  )
}
