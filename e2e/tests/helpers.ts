import { APIRequestContext, expect, Page, test as base } from '@playwright/test'

export interface Row {
  id: number
  idx: number
  ts: number | null
  lat: number | null
  lon: number | null
  lat_orig: number | null
  lon_orig: number | null
  flags: number
  excluded: number
  sequence_id: number | null
  pos_method: string | null
  heading: number | null
}

// Folder of the simulated ride, as seen by the server (PSS_DEFAULT_DIR)
export async function ridePath(request: APIRequestContext): Promise<string> {
  const fs = await (await request.get('/api/fs?path=~')).json()
  return `${fs.path}/Sortie_test`
}

export async function waitJobs(request: APIRequestContext, pid: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const jobs = await (await request.get(`/api/projects/${pid}/jobs`)).json()
    if (jobs.length && jobs.every((j: { state: string }) => j.state !== 'running')) return jobs
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('tâches toujours en cours')
}

// A project with the simulated ride imported (thumbnails included); settings optional
export async function newProject(request: APIRequestContext, name: string, settings?: Record<string, number>): Promise<string> {
  const pid = (await (await request.post('/api/projects', { data: { name } })).json()).id as string
  await request.post(`/api/projects/${pid}/import`, { data: { paths: [await ridePath(request)] } })
  await waitJobs(request, pid)
  if (settings) expect((await request.patch(`/api/projects/${pid}`, { data: { settings } })).ok()).toBeTruthy()
  return pid
}

export async function rows(request: APIRequestContext, pid: string): Promise<Row[]> {
  const d = await (await request.get(`/api/projects/${pid}/photos`)).json()
  return d.rows.map((r: unknown[]) => Object.fromEntries(d.fields.map((f: string, i: number) => [f, r[i]])) as Row)
}

// Opens a project from the list; the map tiles are not fetched (no network in tests, and faster)
export async function openProject(page: Page, name: string) {
  await page.goto('/')
  await page.locator('.project-name', { hasText: name }).click()
  await expect(page.locator('.steps .step').first()).toBeVisible()
}

// Tab of the project screen: a step, by its label
export function tab(page: Page, label: string) {
  return page.getByRole('tab').filter({ has: page.locator('.lab', { hasText: label }) })
}

// Number of the photo shown in the side panel (« 81 / 162 »), once it is loaded
export function photoNumber(page: Page) {
  return page.locator('.tab-body').innerText().then((t) => Number(t.match(/(\d+) \/ \d+/)?.[1] ?? NaN))
}
export async function pickOnTimeline(page: Page, fraction: number): Promise<number> {
  const cv = page.locator('canvas.timeline')
  const w = (await cv.boundingBox())!.width
  await cv.click({ position: { x: w * fraction, y: 30 } })
  let n = NaN
  await expect.poll(async () => (n = await photoNumber(page))).toBeGreaterThan(0)
  return n
}

// Every test: no JavaScript error in the page, no request to tile servers
export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.route(/tile\.openstreetmap|geopf|arcgis|panoramax\.xyz|\.mvt|\.pbf/, (r) => r.fulfill({ status: 204 }))
      await use(errors)
      expect(errors, 'erreurs JavaScript dans la page').toEqual([])
    },
    { auto: true },
  ],
})
export { expect }
