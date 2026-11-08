import { t } from './i18n'

// Raster basemaps. Each provider's attribution is shown on the map, as their terms require.

export interface Basemap {
  id: string
  name: string
  url: string
  attribution: string
  maxzoom: number
  custom?: boolean
}

const IGN_ORTHO =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS' +
  '&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}'

// A function: names depend on the language
export const builtinBasemaps = (): Basemap[] => [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  {
    id: 'esri',
    name: t('map.base.esri'),
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxzoom: 19,
  },
  // IGN orthophotos (France, about 20 cm per pixel, very high resolution in some areas), Géoplateforme WMTS,
  // open data (Licence Ouverte Etalab 2.0), no key. Tiles beyond maxzoom are enlarged by the map.
  {
    id: 'ign-ortho',
    name: t('map.base.ign'),
    url: IGN_ORTHO,
    attribution: '© <a href="https://geoservices.ign.fr" target="_blank">IGN</a> – Géoplateforme (orthophotographies)',
    maxzoom: 19,
  },
  {
    id: 'ign-ortho-max',
    name: t('map.base.ignMax'),
    url: IGN_ORTHO,
    attribution: '© <a href="https://geoservices.ign.fr" target="_blank">IGN</a> – Géoplateforme (orthophotographies)',
    maxzoom: 21,
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
