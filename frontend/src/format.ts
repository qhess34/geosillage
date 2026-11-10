import { t } from './i18n'

// Display helpers. Capture times are camera wall-clock times stored as UTC epochs.

export function fmtTime(ts: number | null | undefined, withDate = true): string {
  if (ts == null) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  const t = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  return withDate ? `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${t}` : t
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.round(s % 60)
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${sec} s` : `${sec} s`
}

// Signed duration with seconds: +1 h 15 min 07 s
export function fmtShift(s: number): string {
  const a = Math.abs(Math.round(s))
  const h = Math.floor(a / 3600)
  const m = Math.floor((a % 3600) / 60)
  const sec = a % 60
  const parts = [h ? `${h} h` : '', h || m ? `${String(m).padStart(h ? 2 : 1, '0')} min` : '', `${String(sec).padStart(h || m ? 2 : 1, '0')} s`]
  return `${s < 0 ? '−' : '+'}${parts.filter(Boolean).join(' ')}`
}

export function fmtDistance(m: number | null | undefined): string {
  if (m == null) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

export function fmtCoord(lat: number | null, lon: number | null): string {
  return lat == null || lon == null ? '—' : `${lat.toFixed(6)}, ${lon.toFixed(6)}`
}

export function fmtSize(b: number): string {
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} ${t('unit.mb')}` : `${Math.round(b / 1e3)} ${t('unit.kb')}`
}
