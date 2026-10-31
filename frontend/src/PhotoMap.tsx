import maplibregl, { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'react'
import { FLAGS, PhotoRow, seqColor, Sequence } from './api'
import { Basemap } from './basemaps'

interface Props {
  photos: PhotoRow[]
  sequences: Sequence[]
  basemap: Basemap
  selectedId: number | null
  range: [number, number] | null
  onSelect: (id: number, extend: boolean) => void
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
          anomaly: p.flags & ANOMALY ? 1 : 0,
          heading: p.heading ?? -1, // -1 = no heading (null is not usable in filters)
          manual: p.heading_manual != null ? 1 : 0,
        },
      })),
  }
}

function lineGeoJSON(photos: PhotoRow[]): GeoJSON.Feature {
  const coords = photos
    .filter((p) => p.lat != null && p.lon != null && !(p.flags & (ANOMALY | FLAGS.DUPLICATE)))
    .map((p) => [p.lon as number, p.lat as number])
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
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

export default function PhotoMap({ photos, sequences, basemap, selectedId, range, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const ready = useRef(false)
  const fitted = useRef(false)
  const latest = useRef({ photos, sequences, selectedId, range, onSelect })
  latest.current = { photos, sequences, selectedId, range, onSelect }

  const rangeFilter = (r: [number, number] | null): maplibregl.FilterSpecification =>
    r ? ['all', ['>=', ['get', 'idx'], r[0]], ['<=', ['get', 'idx'], r[1]]] : ['==', ['get', 'idx'], -1]

  // Photo layers are (re)added after every style change (basemap switch)
  function addLayers(m: MlMap) {
    const { photos, sequences, selectedId, range } = latest.current
    if (m.getSource('photos')) return
    if (!m.hasImage('arrow')) m.addImage('arrow', arrowImage(), { sdf: true })
    m.addSource('track', { type: 'geojson', data: lineGeoJSON(photos) })
    m.addSource('photos', { type: 'geojson', data: toGeoJSON(photos, sequences) })
    m.addLayer({ id: 'track', type: 'line', source: 'track', paint: { 'line-color': '#6b7280', 'line-width': 1.5, 'line-opacity': 0.6 } })
    m.addLayer({
      id: 'range',
      type: 'circle',
      source: 'photos',
      filter: rangeFilter(range),
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 9], 'circle-color': '#facc15', 'circle-opacity': 0.6 },
    })
    m.addLayer({
      id: 'photos',
      type: 'circle',
      source: 'photos',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 5, 19, 8],
        'circle-color': ['case', ['==', ['get', 'anomaly'], 1], '#dc2626', ['get', 'color']],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0, 16, 1],
        'circle-stroke-color': '#ffffff',
      },
    })
    m.addLayer({
      id: 'arrows',
      type: 'symbol',
      source: 'photos',
      minzoom: 15,
      filter: ['>=', ['get', 'heading'], 0],
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
    m.on('click', 'photos', (e) => {
      const f = e.features?.[0]
      if (f) latest.current.onSelect(Number(f.properties?.id), e.originalEvent.shiftKey)
    })
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
    fit(m)
  }, [photos, sequences])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('range')) return
    m.setFilter('range', rangeFilter(range))
  }, [range])

  // Keep the active photo visible on the map while navigating
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('selected')) return
    m.setFilter('selected', ['==', ['get', 'id'], selectedId ?? -1])
    m.setFilter('selected-arrow', ['all', ['==', ['get', 'id'], selectedId ?? -1], ['>=', ['get', 'heading'], 0]])
    const p = photos.find((x) => x.id === selectedId)
    if (p && p.lat != null && p.lon != null) {
      const pt = m.project([p.lon, p.lat])
      const c = m.getContainer()
      const margin = 60
      if (pt.x < margin || pt.y < margin || pt.x > c.clientWidth - margin || pt.y > c.clientHeight - margin) {
        m.easeTo({ center: [p.lon, p.lat], duration: 300 })
      }
    }
  }, [selectedId, photos])

  return <div ref={el} className="map" />
}
