// Client-side mirror of backend/app/core/timesync.py, used for the live preview while dragging.
// The backend recomputes everything when the offset is applied.

export type TrackPoint = [number, number, number] // [ts, lat, lon]
export type Track = TrackPoint[][]

const R = 6371008.8
const rad = Math.PI / 180

function lerp(a: TrackPoint, b: TrackPoint, t: number): [number, number] {
  // Small distances: linear interpolation in lat/lon is indistinguishable from the geodesic
  const f = (t - a[0]) / (b[0] - a[0])
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

export function positionAt(track: Track, t: number, maxExtra = 5): [number, number] | null {
  for (const run of track) {
    const start = run[0][0]
    const end = run[run.length - 1][0]
    if (t < start - maxExtra || t > end + maxExtra) continue
    if (t <= start) return lerp(run[0], run[1], t)
    if (t >= end) return lerp(run[run.length - 2], run[run.length - 1], t)
    let lo = 0
    let hi = run.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (run[mid][0] <= t) lo = mid
      else hi = mid
    }
    return lerp(run[lo], run[lo + 1], t)
  }
  return null
}

// Direction of travel on the track at time t (degrees from north), from the positions 1 s before and after
export function bearingAt(track: Track, t: number): number | null {
  const a = positionAt(track, t - 1)
  const b = positionAt(track, t + 1)
  if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return null
  const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad)
  const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad)
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360
}

// Project a point on the track near the photo time; returns the offset and the snapped position
export function snap(track: Track, photoTs: number, lat: number, lon: number, windowS = 30): { offset: number; lat: number; lon: number } | null {
  const k = R * rad
  const c = Math.cos(lat * rad)
  let best: { d: number; t: number; lat: number; lon: number } | null = null
  for (const run of track) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i]
      const b = run[i + 1]
      if (b[0] < photoTs - windowS || a[0] > photoTs + windowS) continue
      const ax = (a[2] - lon) * k * c
      const ay = (a[1] - lat) * k
      const dx = (b[2] - a[2]) * k * c
      const dy = (b[1] - a[1]) * k
      const l2 = dx * dx + dy * dy
      const f = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2))
      const d = Math.hypot(ax + f * dx, ay + f * dy)
      if (!best || d < best.d) {
        const t = a[0] + f * (b[0] - a[0])
        const [plat, plon] = lerp(a, b, t)
        best = { d, t, lat: plat, lon: plon }
      }
    }
  }
  if (!best) return null
  return { offset: Math.round((best.t - photoTs) * 100) / 100, lat: best.lat, lon: best.lon }
}
