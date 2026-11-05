import maplibregl, { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'react'
import { FLAGS, PhotoRow, seqColor, Sequence } from './api'
import { Basemap } from './basemaps'
import type { SnapPreview } from './OsmSnapPanel'
import { addOverlay, bindOverlayTooltip, OverlaySettings, updateOverlay } from './panoramaxLayer'
import { positionAt, snap, Track } from './timesync'

interface Props {
  photos: PhotoRow[]
  sequences: Sequence[]
  basemap: Basemap
  selectedId: number | null
  range: [number, number] | null
  editMode: boolean // positions: drag the selected photo, or click the map to place it
  sync: { track: Track; offset: number | null } | null // time synchronisation mode
  viewAzimuth?: number | null // direction looked at in the 360° viewer: the selected arrow follows it
  overlay: OverlaySettings // photos already published on Panoramax
  follow: boolean // move the map to keep the selected photo visible while navigating
  centerTick: number // incremented to center the map on the selected photo once
  snapPreview?: SnapPreview | null // OSM snapping preview: candidate ways and moves
  onSelect: (id: number, extend: boolean) => void
  onMove: (id: number, lat: number, lon: number) => void
  onSyncOffset: (offset: number, final: boolean) => void
}

const SYNC = '#ea580c'

function syncTrackGeoJSON(track: Track | undefined): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiLineString', coordinates: (track ?? []).map((run) => run.map((p) => [p[2], p[1]])) },
  }
}

// Preview: every dated photo placed on the track at (time + offset)
function ghostsGeoJSON(photos: PhotoRow[], track: Track | undefined, offset: number | null): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  if (track && offset != null) {
    for (const p of photos) {
      if (p.ts == null) continue
      const pos = positionAt(track, p.ts + offset)
      if (pos) features.push({ type: 'Feature', properties: { id: p.id }, geometry: { type: 'Point', coordinates: [pos[1], pos[0]] } })
    }
  }
  return { type: 'FeatureCollection', features }
}

const ANOMALY = FLAGS.GPS_JUMP | FLAGS.INVALID_COORD

function toGeoJSON(photos: PhotoRow[], sequences: Sequence[]): GeoJSON.FeatureCollection {
  const colors = new Map(sequences.map((s) => [s.id, seqColor(sequences, s.id)]))
  return {
    type: 'FeatureCollection',
    features: photos
      .filter((p) => p.lat != null && p.lon != null && !(p.flags & FLAGS.INVALID_COORD))
      .map((p) => ({
        type: 'Feature',
        id: p.id,
        geometry: { type: 'Point', coordinates: [p.lon as number, p.lat as number] },
        properties: {
          id: p.id,
          idx: p.idx,
          color: p.sequence_id != null ? colors.get(p.sequence_id) ?? '#9ca3af' : '#9ca3af',
          excluded: p.excluded ? 1 : 0,
          anomaly: p.flags & ANOMALY && !p.pos_method ? 1 : 0,
          corrected: p.pos_method ? 1 : 0,
          heading: p.heading ?? -1, // -1 = no heading (null is not usable in filters)
          manual: p.heading_manual != null ? 1 : 0,
        },
      })),
  }
}

// Selected photo without a position: the positioned photos taken just before and after it, joined by a dashed line
// (the photo is somewhere between them; in Positions mode, a click on the map places it)
export function gapNeighbours(photos: PhotoRow[], selectedId: number | null): [PhotoRow, PhotoRow | null] | null {
  const i = photos.findIndex((p) => p.id === selectedId)
  if (i < 0 || photos[i].lat != null) return null
  const ok = (p: PhotoRow) => p.lat != null && p.lon != null && !p.excluded
  let a: PhotoRow | null = null
  for (let k = i - 1; k >= 0 && !a; k--) if (ok(photos[k])) a = photos[k]
  let b: PhotoRow | null = null
  for (let k = i + 1; k < photos.length && !b; k++) if (ok(photos[k])) b = photos[k]
  if (!a && !b) return null
  return a ? [a, b] : [b as PhotoRow, null]
}

function gapGeoJSON(photos: PhotoRow[], selectedId: number | null): GeoJSON.FeatureCollection {
  const n = gapNeighbours(photos, selectedId)
  const features: GeoJSON.Feature[] = []
  if (n) {
    const pts = n.filter((p): p is PhotoRow => p != null).map((p) => [p.lon as number, p.lat as number])
    for (const c of pts) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })
    if (pts.length === 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } })
  }
  return { type: 'FeatureCollection', features }
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

function lineGeoJSON(photos: PhotoRow[]): GeoJSON.Feature {
  const coords = photos
    .filter((p) => p.lat != null && p.lon != null && !(p.flags & (ANOMALY | FLAGS.DUPLICATE)))
    .map((p) => [p.lon as number, p.lat as number])
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
}

// Original → corrected position links (and original positions) for corrected photos
function movesGeoJSON(photos: PhotoRow[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const p of photos) {
    if (!p.pos_method || p.lat_orig == null || p.lon_orig == null || p.lat == null || p.lon == null) continue
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[p.lon_orig, p.lat_orig], [p.lon, p.lat]] },
    })
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon_orig, p.lat_orig] } })
  }
  return { type: 'FeatureCollection', features }
}

function rasterStyle(b: Basemap): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [b.url], tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  }
}

// Arrow icon pointing north (rotated by the heading); SDF so it can be coloured
function arrowImage(): ImageData {
  const s = 32
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d') as CanvasRenderingContext2D
  g.fillStyle = '#000'
  g.beginPath()
  g.moveTo(s / 2, 1)
  g.lineTo(s - 7, s - 6)
  g.lineTo(s / 2, s - 12)
  g.lineTo(7, s - 6)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, s, s)
}

export default function PhotoMap({ photos, sequences, basemap, selectedId, range, editMode, sync, viewAzimuth, overlay, follow, centerTick, snapPreview, onSelect, onMove, onSyncOffset }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const marker = useRef<maplibregl.Marker | null>(null)
  const syncMarker = useRef<maplibregl.Marker | null>(null)
  const dragging = useRef(false)
  const ready = useRef(false)
  const fitted = useRef(false)
  const latest = useRef({ photos, sequences, selectedId, range, editMode, sync, overlay, onSelect, onMove, onSyncOffset, snapPreview })
  latest.current = { photos, sequences, selectedId, range, editMode, sync, overlay, onSelect, onMove, onSyncOffset, snapPreview }

  const rangeFilter = (r: [number, number] | null): maplibregl.FilterSpecification =>
    r ? ['all', ['>=', ['get', 'idx'], r[0]], ['<=', ['get', 'idx'], r[1]]] : ['==', ['get', 'idx'], -1]

  // Photo layers are (re)added after every style change (basemap switch)
  function addLayers(m: MlMap) {
    const { photos, sequences, selectedId, range } = latest.current
    if (m.getSource('photos')) return
    if (!m.hasImage('arrow')) m.addImage('arrow', arrowImage(), { sdf: true })
    m.addSource('track', { type: 'geojson', data: lineGeoJSON(photos) })
    m.addSource('photos', { type: 'geojson', data: toGeoJSON(photos, sequences) })
    m.addSource('moves', { type: 'geojson', data: movesGeoJSON(photos) })
    m.addSource('gap', { type: 'geojson', data: gapGeoJSON(photos, selectedId) })
    const sn = latest.current.snapPreview
    m.addSource('snap-ways', { type: 'geojson', data: sn?.ways ?? EMPTY })
    m.addSource('snap-moves', { type: 'geojson', data: sn?.moves ?? EMPTY })
    const s = latest.current.sync
    m.addSource('sync-track', { type: 'geojson', data: syncTrackGeoJSON(s?.track) })
    m.addSource('ghosts', { type: 'geojson', data: ghostsGeoJSON(photos, s?.track, s?.offset ?? null) })
    addOverlay(m, latest.current.overlay) // first: below the project's own layers
    m.addLayer({ id: 'track', type: 'line', source: 'track', paint: { 'line-color': '#6b7280', 'line-width': 1.5, 'line-opacity': 0.6 } })
    m.addLayer({
      id: 'moves-line',
      type: 'line',
      source: 'moves',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#7c3aed', 'line-width': 1.5, 'line-dasharray': [2, 2] },
    })
    m.addLayer({
      id: 'moves-orig',
      type: 'circle',
      source: 'moves',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 3, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 1.5 },
    })
    m.addLayer({
      id: 'snap-ways',
      type: 'line',
      source: 'snap-ways',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'chosen'], 1], '#0369a1', '#38bdf8'],
        'line-width': ['case', ['==', ['get', 'chosen'], 1], 6, 3],
        'line-opacity': 0.75,
      },
    })
    m.addLayer({
      id: 'snap-hl',
      type: 'line',
      source: 'snap-ways',
      filter: ['==', ['get', 'id'], -1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#facc15', 'line-width': 9, 'line-opacity': 0.9 },
    })
    m.addLayer({
      id: 'snap-moves',
      type: 'line',
      source: 'snap-moves',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#0369a1', 'line-width': 1.5, 'line-dasharray': [2, 1.5] },
    })
    m.addLayer({
      id: 'snap-new',
      type: 'circle',
      source: 'snap-moves',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 3.5, 'circle-color': '#0369a1', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
    })
    m.addLayer({
      id: 'gap-line',
      type: 'line',
      source: 'gap',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#dc2626', 'line-width': 2.5, 'line-dasharray': [1.5, 1.5] },
    })
    m.addLayer({
      id: 'gap-ends',
      type: 'circle',
      source: 'gap',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 2.5 },
    })
    m.addLayer({
      id: 'sync-track',
      type: 'line',
      source: 'sync-track',
      layout: { visibility: s ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': SYNC, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 6], 'line-opacity': 0.45 },
    })
    m.addLayer({
      id: 'range',
      type: 'circle',
      source: 'photos',
      filter: rangeFilter(range),
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 13, 19, 18], 'circle-color': '#facc15', 'circle-opacity': 0.75 },
    })
    m.addLayer({
      id: 'photos',
      type: 'circle',
      source: 'photos',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 5, 19, 8],
        'circle-color': ['case', ['==', ['get', 'excluded'], 1], '#6b7280', ['==', ['get', 'anomaly'], 1], '#dc2626', ['get', 'color']],
        'circle-opacity': ['case', ['==', ['get', 'excluded'], 1], 0.35, 1],
        // zoom must stay at the top level of the expression
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', ['==', ['get', 'corrected'], 1], 2, 0], 16, ['case', ['==', ['get', 'corrected'], 1], 2, 1]],
        'circle-stroke-color': ['case', ['==', ['get', 'corrected'], 1], '#7c3aed', '#ffffff'],
      },
    })
    // selected photos (range, snapping scope): a ring above the points, visible at any zoom
    m.addLayer({
      id: 'range-ring',
      type: 'circle',
      source: 'photos',
      filter: rangeFilter(range),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8, 19, 11],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#d97706',
        'circle-stroke-width': 2.5,
      },
    })
    m.addLayer({
      id: 'arrows',
      type: 'symbol',
      source: 'photos',
      minzoom: 15,
      filter: ['all', ['>=', ['get', 'heading'], 0], ['==', ['get', 'excluded'], 0]],
      layout: {
        'icon-image': 'arrow',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.45, 19, 0.9],
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-offset': [0, -22],
      },
      paint: { 'icon-color': ['case', ['==', ['get', 'manual'], 1], '#7c3aed', '#111827'], 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.5 },
    })
    m.addLayer({
      id: 'ghosts',
      type: 'circle',
      source: 'ghosts',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 6], 'circle-color': SYNC, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
    })
    m.addLayer({
      id: 'selected',
      type: 'circle',
      source: 'photos',
      filter: ['==', ['get', 'id'], selectedId ?? -1],
      paint: { 'circle-radius': 9, 'circle-color': '#facc15', 'circle-stroke-width': 3, 'circle-stroke-color': '#111827' },
    })
    m.addLayer({
      id: 'selected-arrow',
      type: 'symbol',
      source: 'photos',
      filter: ['all', ['==', ['get', 'id'], selectedId ?? -1], ['>=', ['get', 'heading'], 0]],
      layout: {
        'icon-image': 'arrow',
        'icon-size': 1.1,
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-offset': [0, -24],
      },
      paint: { 'icon-color': '#facc15', 'icon-halo-color': '#111827', 'icon-halo-width': 2 },
    })
  }

  function fit(m: MlMap) {
    const pts = latest.current.photos.filter((p) => p.lat != null && p.lon != null && !(p.flags & ANOMALY))
    if (fitted.current || !pts.length) return
    const b = new maplibregl.LngLatBounds()
    pts.forEach((p) => b.extend([p.lon as number, p.lat as number]))
    m.fitBounds(b, { padding: 40, duration: 0, maxZoom: 17 })
    fitted.current = true
  }

  useEffect(() => {
    const m = new maplibregl.Map({
      container: el.current as HTMLDivElement,
      style: rasterStyle(basemap),
      center: [2.5, 46.5],
      zoom: 5,
      attributionControl: { compact: false },
    })
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-left')
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    m.on('style.load', () => {
      addLayers(m)
      ready.current = true
      fit(m)
    })
    m.on('click', (e) => {
      const f = m.getLayer('photos') ? m.queryRenderedFeatures(e.point, { layers: ['photos'] })[0] : undefined
      const { editMode, selectedId, photos, onSelect, onMove } = latest.current
      if (f) {
        onSelect(Number(f.properties?.id), e.originalEvent.shiftKey)
        return
      }
      // Edit mode: a click on the map places the selected photo if it has no position yet
      const sel = photos.find((p) => p.id === selectedId)
      if (editMode && sel && (sel.lat == null || sel.lon == null)) onMove(sel.id, e.lngLat.lat, e.lngLat.lng)
    })
    bindOverlayTooltip(m, () => latest.current.overlay.url)
    m.on('mouseenter', 'photos', () => (m.getCanvas().style.cursor = 'pointer'))
    m.on('mouseleave', 'photos', () => (m.getCanvas().style.cursor = ''))
    map.current = m
    ;(window as unknown as { __pssMap?: MlMap }).__pssMap = m // inspection in end-to-end tests
    return () => {
      m.remove()
      map.current = null
      ready.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    // diff: false forces a full reload so that 'style.load' fires and photo layers are re-added
    m.setStyle(rasterStyle(basemap), { diff: false })
  }, [basemap])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    ;(m.getSource('photos') as GeoJSONSource | undefined)?.setData(toGeoJSON(photos, sequences))
    ;(m.getSource('track') as GeoJSONSource | undefined)?.setData(lineGeoJSON(photos))
    ;(m.getSource('moves') as GeoJSONSource | undefined)?.setData(movesGeoJSON(photos))
    fit(m)
  }, [photos, sequences])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    ;(m.getSource('gap') as GeoJSONSource | undefined)?.setData(gapGeoJSON(photos, selectedId))
  }, [photos, selectedId])

  // OSM snapping preview
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    ;(m.getSource('snap-ways') as GeoJSONSource | undefined)?.setData(snapPreview?.ways ?? EMPTY)
    ;(m.getSource('snap-moves') as GeoJSONSource | undefined)?.setData(snapPreview?.moves ?? EMPTY)
    if (m.getLayer('snap-hl')) m.setFilter('snap-hl', ['==', ['get', 'id'], snapPreview?.highlight ?? -1])
  }, [snapPreview])

  // Sync mode: track and preview of all photos shifted by the offset (one update per animation frame)
  const syncTrack = sync?.track
  const syncOffset = sync?.offset ?? null
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('sync-track')) return
    m.setLayoutProperty('sync-track', 'visibility', syncTrack ? 'visible' : 'none')
    ;(m.getSource('sync-track') as GeoJSONSource | undefined)?.setData(syncTrackGeoJSON(syncTrack))
  }, [syncTrack])
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    const id = requestAnimationFrame(() =>
      (m.getSource('ghosts') as GeoJSONSource | undefined)?.setData(ghostsGeoJSON(latest.current.photos, syncTrack, syncTrack ? syncOffset : null)),
    )
    return () => cancelAnimationFrame(id)
  }, [syncTrack, syncOffset, photos])

  // Sync mode: the selected photo's marker slides along the track only
  useEffect(() => {
    const m = map.current
    syncMarker.current?.remove()
    syncMarker.current = null
    const s = latest.current.sync
    if (!m || !syncTrack || selectedId == null || !s) return
    const p = photos.find((x) => x.id === selectedId)
    if (!p || p.ts == null) return
    const ts = p.ts
    const start = (s.offset != null && positionAt(syncTrack, ts + s.offset)) || (p.lat_orig != null && p.lon_orig != null ? [p.lat_orig, p.lon_orig] : null)
    if (!start) return
    const el = document.createElement('div')
    el.className = 'sync-marker'
    el.title = 'Glisser le long de la trace jusqu\'à l\'élément visible sur la photo'
    const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([start[1], start[0]]).addTo(m)
    let last: number | null = null
    mk.on('dragstart', () => (dragging.current = true))
    mk.on('drag', () => {
      const ll = mk.getLngLat()
      const sn = snap(syncTrack, ts, ll.lat, ll.lng)
      if (!sn) return
      mk.setLngLat([sn.lon, sn.lat])
      last = sn.offset
      latest.current.onSyncOffset(sn.offset, false)
    })
    mk.on('dragend', () => {
      dragging.current = false
      if (last != null) latest.current.onSyncOffset(last, true)
    })
    syncMarker.current = mk
    return () => {
      mk.remove()
    }
    // offset changes move the marker below, without re-creating it (it may be dragged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTrack, selectedId, photos])
  useEffect(() => {
    const mk = syncMarker.current
    if (!mk || dragging.current || !syncTrack || syncOffset == null) return
    const p = latest.current.photos.find((x) => x.id === latest.current.selectedId)
    if (!p || p.ts == null) return
    const pos = positionAt(syncTrack, p.ts + syncOffset)
    if (pos) mk.setLngLat([pos[1], pos[0]])
  }, [syncOffset, syncTrack])

  // Edit mode: a draggable marker on the selected photo
  useEffect(() => {
    const m = map.current
    marker.current?.remove()
    marker.current = null
    if (!m || !editMode || sync || selectedId == null) return
    const p = photos.find((x) => x.id === selectedId)
    if (!p || p.lat == null || p.lon == null) return
    const mk = new maplibregl.Marker({ draggable: true, color: '#7c3aed' }).setLngLat([p.lon, p.lat]).addTo(m)
    mk.getElement().title = 'Glisser pour corriger la position'
    mk.on('dragend', () => {
      const ll = mk.getLngLat()
      latest.current.onMove(p.id, ll.lat, ll.lng)
    })
    marker.current = mk
    return () => {
      mk.remove()
    }
  }, [editMode, selectedId, photos, sync])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('range')) return
    m.setFilter('range', rangeFilter(range))
    if (m.getLayer('range-ring')) m.setFilter('range-ring', rangeFilter(range))
  }, [range])

  // Panoramax overlay: shown / hidden, instance changed
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    updateOverlay(m, overlay)
  }, [overlay])

  // While moving points (positions or sync mode), a double click must not zoom the map: selecting a photo then
  // grabbing its marker quickly is a double click
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (editMode || sync) m.doubleClickZoom.disable()
    else m.doubleClickZoom.enable()
  }, [editMode, sync])

  // The selected photo's arrow turns with the 360° viewer
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('selected-arrow')) return
    m.setLayoutProperty('selected-arrow', 'icon-rotate', viewAzimuth != null ? viewAzimuth : ['get', 'heading'])
  }, [viewAzimuth])

  // Keep the active photo visible on the map while navigating (only when the selection changes: moving a point
  // must not move the map)
  const lastCentered = useRef<number | null>(null)
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('selected')) return
    m.setFilter('selected', ['==', ['get', 'id'], selectedId ?? -1])
    if (lastCentered.current === selectedId) {
      m.setFilter('selected-arrow', ['all', ['==', ['get', 'id'], selectedId ?? -1], ['>=', ['get', 'heading'], 0]])
      return
    }
    lastCentered.current = selectedId
    m.setFilter('selected-arrow', ['all', ['==', ['get', 'id'], selectedId ?? -1], ['>=', ['get', 'heading'], 0]])
    const p = photos.find((x) => x.id === selectedId)
    if (follow && p && p.lat != null && p.lon != null) {
      // Follow: the selected photo stays in the centre; a short animation, interrupted by the next key press
      m.stop()
      m.easeTo({ center: [p.lon, p.lat], duration: 180, easing: (t) => t })
    } else if (p && p.lat == null) {
      // Photo without a position (invisible on the map): frame the photos taken just before and after it
      const n = gapNeighbours(photos, selectedId)
      if (n) {
        const pts = n.filter((x): x is PhotoRow => x != null).map((x) => [x.lon as number, x.lat as number] as [number, number])
        m.stop()
        if (pts.length === 2) m.fitBounds(new maplibregl.LngLatBounds(pts[0], pts[0]).extend(pts[1]), { padding: 120, maxZoom: 18.5, duration: 180 })
        else m.easeTo({ center: pts[0], zoom: Math.max(m.getZoom(), 17), duration: 180 })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, photos])

  // "Center" button: once, on request
  useEffect(() => {
    const m = map.current
    if (!m || !centerTick) return
    const p = latest.current.photos.find((x) => x.id === latest.current.selectedId)
    if (p && p.lat != null && p.lon != null) m.easeTo({ center: [p.lon, p.lat], duration: 300 })
  }, [centerTick])

  return <div ref={el} className="map" />
}
