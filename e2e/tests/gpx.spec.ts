import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, newProject, openProject, ridePath, rows, test } from './helpers'

// A GPX "recorded" along the ride: camera clock 2 h ahead of UTC, trace ~4 m to the north
async function writeGpx(request: Parameters<typeof rows>[0], pid: string, name: string): Promise<string> {
  const pts = (await rows(request, pid)).filter((r) => r.flags === 0 && r.lat_orig != null && r.ts != null)
  const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  const trk = pts.map((r) => `<trkpt lat="${r.lat_orig! + 0.00004}" lon="${r.lon_orig}"><time>${iso(r.ts! - 7200)}</time></trkpt>`).join('')
  const path = `${dirname(await ridePath(request))}/${name}`
  writeFileSync(path, `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${trk}</trkseg></trk></gpx>`)
  return name
}

test('GPX : import dans l\'onglet Synchro, décalage horaire détecté, recalage avec aperçu puis annulation', async ({ page, request }) => {
  const pid = await newProject(request, 'GPX')
  const file = await writeGpx(request, pid, `trace-${pid.slice(0, 6)}.gpx`)
  await openProject(page, 'GPX')
  await page.locator('.tab', { hasText: 'Synchro' }).click()
  const sec = page.locator('.gpx-section')
  await sec.getByRole('button', { name: 'Importer un GPX…' }).click()
  const picker = page.getByRole('dialog', { name: 'Choisir une trace GPX' })
  await picker.locator('.fs-dir', { hasText: file }).click()
  await expect(sec).toContainText(`Trace GPX « ${file} »`)
  await expect(sec).toContainText('+2 h')
  await expect(sec).toContainText("d'après les positions de la caméra")
  expect((await (await request.get(`/api/projects/${pid}/track`)).json()).source).toBe('gpx')

  await sec.getByRole('button', { name: /Recaler des photos sur la ligne GPX/ }).click()
  const panel = page.getByRole('dialog', { name: 'Recaler sur la ligne GPX' })
  await expect(panel.locator('.gpx-snap-stats')).toContainText('photo(s) déplacée(s)')
  expect((await rows(request, pid)).some((r) => r.pos_method === 'gpx')).toBe(false) // preview only
  await panel.getByRole('button', { name: /^Recaler \d+ photo/ }).click()
  await expect(page.locator('.toast')).toContainText('recalée(s) sur le GPX')
  expect((await rows(request, pid)).filter((r) => r.pos_method === 'gpx').length).toBeGreaterThan(100)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await rows(request, pid)).some((r) => r.pos_method === 'gpx')).toBe(false)
})
