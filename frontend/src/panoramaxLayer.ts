// Optional overlay: 360° photos already published on a Panoramax instance, coloured by age.
// Uses the instance's public vector tiles (GET /api/map/{z}/{x}/{y}.mvt, see the Panoramax API):
//   layer "sequences" (zoom >= 7): date (YYYY-MM-DD), type (flat | equirectangular), model
//   layer "pictures"  (zoom >= 15): ts (date/time), heading, type, model
// Both also carry ids (id, account_id; pictures: first_sequence / sequences), but not the author's name: it is
// fetched on hover from the API (see authorOf).
import maplibregl, { Map as MlMap } from 'maplibre-gl'

// Federated meta-catalogue: harvests the metadata of all the referenced instances (the one panoramax.fr uses) and
// serves the same vector tiles as an instance
export const META_CATALOG_URL = 'https://api.panoramax.xyz'
export const DEFAULT_PANORAMAX_URL = META_CATALOG_URL
const OLD_DEFAULT_URL = 'https://panoramax.openstreetmap.fr'
export const PANORAMAX_PRESETS = [
  { url: META_CATALOG_URL, label: 'Toutes les instances (méta-catalogue panoramax.fr)' },
  { url: 'https://panoramax.openstreetmap.fr', label: 'OpenStreetMap France' },
  { url: 'https://panoramax.ign.fr', label: 'IGN' },
]
const KEY = 'pss-panoramax-overlay'

export interface OverlaySettings {
  enabled: boolean
  url: string
}

export function loadOverlay(): OverlaySettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    let url = typeof v.url === 'string' && v.url ? v.url : DEFAULT_PANORAMAX_URL
    if (!v.v && url === OLD_DEFAULT_URL) url = DEFAULT_PANORAMAX_URL // former default: now all the instances
    return { enabled: !!v.enabled, url }
  } catch {
    return { enabled: false, url: DEFAULT_PANORAMAX_URL }
  }
}

export function saveOverlay(s: OverlaySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, v: 2 }))
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

// 360° only; a feature without "type" is kept (in case a catalogue does not provide it)
const IS_360: maplibregl.FilterSpecification = ['any', ['!', ['has', 'type']], ['==', ['get', 'type'], 'equirectangular']]
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

// ---- Author, fetched on hover and cached (the tiles only give ids) ----

const authors = new Map<string, Promise<string | null>>()

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(String(r.status))
  return r.json()
}

// Name of the producer in a STAC collection or item (providers with the "producer" role, or geovisio:producer)
function producerOf(o: any): string | null {
  const props = o?.properties ?? {}
  const direct = props['geovisio:producer'] ?? o?.['geovisio:producer']
  if (typeof direct === 'string' && direct) return direct
  const providers: any[] = o?.providers ?? props.providers ?? []
  const p = providers.find((x) => Array.isArray(x?.roles) && x.roles.includes('producer')) ?? providers[0]
  return typeof p?.name === 'string' && p.name ? p.name : null
}

function firstSequence(p: Record<string, unknown>): string | null {
  if (typeof p.first_sequence === 'string' && p.first_sequence) return p.first_sequence
  try {
    const seqs = typeof p.sequences === 'string' ? JSON.parse(p.sequences) : p.sequences
    if (Array.isArray(seqs) && typeof seqs[0] === 'string') return seqs[0]
  } catch {
    /* not JSON */
  }
  return null
}

// Tries, in order: the sequence (collection), the picture (search by id), the account (users route)
export function authorOf(base: string, layer: string, p: Record<string, unknown>): Promise<string | null> {
  const api = `${base.replace(/\/+$/, '')}/api`
  const id = typeof p.id === 'string' ? p.id : null
  const seq = layer === 'pnx-sequences' ? id : firstSequence(p)
  const account = typeof p.account_id === 'string' ? p.account_id : null
  const key = `${api}|${seq ?? ''}|${layer === 'pnx-pictures' ? id ?? '' : ''}|${account ?? ''}`
  let r = authors.get(key)
  if (!r) {
    r = (async () => {
      const tries: (() => Promise<string | null>)[] = []
      if (seq) tries.push(async () => producerOf(await getJson(`${api}/collections/${encodeURIComponent(seq)}`)))
      if (layer === 'pnx-pictures' && id)
        tries.push(async () => producerOf((await getJson(`${api}/search?ids=${encodeURIComponent(id)}`))?.features?.[0]))
      if (account)
        tries.push(async () => {
          const u = await getJson(`${api}/users/${encodeURIComponent(account)}`)
          return typeof u?.name === 'string' && u.name ? u.name : null
        })
      for (const t of tries) {
        try {
          const name = await t()
          if (name) return name
        } catch {
          /* next one */
        }
      }
      return null
    })()
    authors.set(key, r)
  }
  return r
}

function fmtDate(v: unknown): string {
  const s = String(v ?? '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/)
  if (!m) return s
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`
}

// Tooltip on hover: date, author and camera of the Panoramax photo / sequence
export function bindOverlayTooltip(m: MlMap, getUrl: () => string): void {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'pnx-popup', offset: 8 })
  let shown = '' // feature currently in the tooltip
  const show = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) return
    const p = f.properties || {}
    const key = `${f.layer.id}|${String(p.id ?? '')}|${String(p.ts ?? p.date ?? '')}`
    if (key === shown && popup.isOpen()) {
      popup.setLngLat(e.lngLat) // same feature: only follow the mouse
      return
    }
    shown = key
    const what = f.layer.id === 'pnx-pictures' ? 'Photo 360° Panoramax' : 'Séquence 360° Panoramax'
    const date = fmtDate(p.ts ?? p.date)
    const model = p.model ? ` · ${String(p.model)}` : ''
    const el = document.createElement('div')
    el.textContent = `${what} · ${date}${model}`
    const who = document.createElement('div')
    who.className = 'muted'
    who.textContent = 'Auteur : …'
    el.appendChild(who)
    popup.setLngLat(e.lngLat).setDOMContent(el).addTo(m)
    m.getCanvas().style.cursor = 'help'
    authorOf(getUrl(), f.layer.id, p).then((name) => {
      if (shown === key) who.textContent = `Auteur : ${name ?? 'inconnu'}`
    })
  }
  const hide = () => {
    shown = ''
    popup.remove()
    m.getCanvas().style.cursor = ''
  }
  for (const id of OVERLAY_LAYERS) {
    m.on('mousemove', id, show)
    m.on('mouseleave', id, hide)
  }
}
