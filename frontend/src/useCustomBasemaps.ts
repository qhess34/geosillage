import { useState } from 'react'
import { Basemap, loadCustomBasemaps, saveCustomBasemaps } from './basemaps'

// Background maps added by the user (XYZ), kept in the browser for every ride
export function useCustomBasemaps() {
  const [custom, setCustom] = useState<Basemap[]>(loadCustomBasemaps)
  const save = (list: Basemap[]) => {
    setCustom(list)
    saveCustomBasemaps(list)
  }
  const add = (name: string, url: string, attribution: string): Basemap => {
    const b: Basemap = { id: `custom-${Date.now()}`, name, url, attribution, maxzoom: 19, custom: true }
    save([...custom, b])
    return b
  }
  const remove = (id: string) => save(custom.filter((b) => b.id !== id))
  return { custom, add, remove }
}
