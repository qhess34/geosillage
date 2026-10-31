// Raster basemaps. Each provider's attribution is shown on the map, as their terms require.

export interface Basemap {
  id: string
  name: string
  url: string
  attribution: string
  maxzoom: number
  custom?: boolean
}

export const BUILTIN_BASEMAPS: Basemap[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  {
    id: 'esri',
    name: 'Satellite (Esri World Imagery)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxzoom: 19,
  },
  {
    id: 'opentopomap',
    name: 'OpenTopoMap',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      '© OpenStreetMap contributors, SRTM | Style © <a href="https://opentopomap.org" target="_blank">OpenTopoMap</a> (CC-BY-SA)',
    maxzoom: 17,
  },
]

const KEY = 'pss-custom-basemaps'

export function loadCustomBasemaps(): Basemap[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function saveCustomBasemaps(list: Basemap[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}
