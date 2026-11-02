// Optional overlay: 360° photos already published on a Panoramax instance, coloured by age.
// Uses the instance's public vector tiles (GET /api/map/{z}/{x}/{y}.mvt, see the Panoramax API):
//   layer "sequences" (zoom >= 7): date (YYYY-MM-DD), type (flat | equirectangular), model
//   layer "pictures"  (zoom >= 15): ts (date/time), heading, type, model
import maplibregl, { Map as MlMap } from 'maplibre-gl'

export const DEFAULT_PANORAMAX_URL = 'https://panoramax.openstreetmap.fr'
const KEY = 'pss-panoramax-overlay'

export interface OverlaySettings {
  enabled: boolean
  url: string
}

export function loadOverlay(): OverlaySettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { enabled: !!v.enabled, url: typeof v.url === 'string' && v.url ? v.url : DEFAULT_PANORAMAX_URL }
  } catch {
    return { enabled: false, url: DEFAULT_PANORAMAX_URL }
  }
}

export function saveOverlay(s: OverlaySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable */
  }
}

// Age classes (dates are ISO strings: compared as strings)
export const AGE_CLASSES = [
  { label: 'moins d\'un an', color: '#16a34a', years: 1 },
  { label: '1 à 3 ans', color: '#f59e0b', years: 3 },
  { label: 'plus de 3 ans', color: '#b91c1c', years: Infinity },
]

function isoYearsAgo(years: number): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - years)
  return d.toISOString().slice(0, 10)
}

function ageColor(prop: string): maplibregl.ExpressionSpecification {
  return [
    'case',
    ['>=', ['to-string', ['get', prop]], isoYearsAgo(1)],
    AGE_CLASSES[0].color,
    ['>=', ['to-string', ['get', prop]], isoYearsAgo(3)],
    AGE_CLASSES[1].color,
    AGE_CLASSES[2].color,
  ]
}

const IS_360: maplibregl.FilterSpecification = ['==', ['get', 'type'], 'equirectangular']
export const OVERLAY_LAYERS = ['pnx-sequences', 'pnx-pictures']

function tilesUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/api/map/{z}/{x}/{y}.mvt`
}

// Added below the project's own layers (beforeId) so that our photos stay on top
export function addOverlay(m: MlMap, s: OverlaySettings, beforeId?: string): void {
  if (m.getSource('pnx')) return
  m.addSource('pnx', {
    type: 'vector',
    tiles: [tilesUrl(s.url)],
    minzoom: 6,
    maxzoom: 15,
    attribution: '© contributeurs <a href="https://panoramax.fr" target="_blank">Panoramax</a>',
  })
  const visibility = s.enabled ? 'visible' : 'none'
  m.addLayer(
    {
      id: 'pnx-sequences',
      type: 'line',
      source: 'pnx',
      'source-layer': 'sequences',
      minzoom: 7,
      filter: IS_360,
      layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ageColor('date'), 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 16, 5], 'line-opacity': 0.75 },
    },
    beforeId,
  )
  m.addLayer(
    {
      id: 'pnx-pictures',
      type: 'circle',
      source: 'pnx',
      'source-layer': 'pictures',
      minzoom: 15,
      filter: IS_360,
      layout: { visibility },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 2.5, 19, 6],
        'circle-color': ageColor('ts'),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-opacity': 0.8,
      },
    },
    beforeId,
  )
}

export function updateOverlay(m: MlMap, s: OverlaySettings): void {
  const src = m.getSource('pnx') as maplibregl.VectorTileSource | undefined
  if (!src) return
  src.setTiles([tilesUrl(s.url)])
  for (const id of OVERLAY_LAYERS) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', s.enabled ? 'visible' : 'none')
}

function fmtDate(v: unknown): string {
  const s = String(v ?? '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/)
  if (!m) return s
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`
}

// Tooltip on hover: date (and camera) of the Panoramax photo / sequence
export function bindOverlayTooltip(m: MlMap): void {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'pnx-popup', offset: 8 })
  const show = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) return
    const p = f.properties || {}
    const what = f.layer.id === 'pnx-pictures' ? 'Photo 360° Panoramax' : 'Séquence 360° Panoramax'
    const date = fmtDate(p.ts ?? p.date)
    const model = p.model ? ` · ${String(p.model)}` : ''
    const el = document.createElement('div')
    el.textContent = `${what} · ${date}${model}`
    popup.setLngLat(e.lngLat).setDOMContent(el).addTo(m)
    m.getCanvas().style.cursor = 'help'
  }
  const hide = () => {
    popup.remove()
    m.getCanvas().style.cursor = ''
  }
  for (const id of OVERLAY_LAYERS) {
    m.on('mousemove', id, show)
    m.on('mouseleave', id, hide)
  }
}
