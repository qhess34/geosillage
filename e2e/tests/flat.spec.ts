import { expect, openProject, pickOnTimeline, ridePath, tab, test, waitJobs } from './helpers'

// Smartphone ride (flat pictures): the project type comes from the XMP tags of the pictures
test('projet plat : visionneuse sans 360°, direction de la caméra, autre type refusé', async ({ page, request }) => {
  const home = (await ridePath(request)).replace(/\/Sortie_test$/, '')
  const pid = (await (await request.post('/api/projects', { data: { name: 'Sortie plate' } })).json()).id as string
  await request.post(`/api/projects/${pid}/import`, { data: { paths: [`${home}/Sortie_plat`] } })
  await waitJobs(request, pid)
  expect((await (await request.get(`/api/projects/${pid}`)).json()).media).toBe('flat')

  await openProject(page, 'Sortie plate')
  const body = page.locator('.tab-body')
  await tab(page, 'Positions et sens').click()
  await pickOnTimeline(page, 0.5)
  await expect(body.locator('h4', { hasText: 'Cette photo : direction de la caméra' })).toBeVisible()
  await expect(body.getByRole('button', { name: 'Vue 360°' })).toHaveCount(0)
  await expect(body.getByRole('button', { name: 'À plat' })).toHaveCount(0)

  await tab(page, 'Import').click()
  await expect(page.locator('table.summary')).toContainText('Plates')
  await expect(page.locator('table.summary')).toContainText('Intervalle médian')

  // heading source (step « Positions et sens », « Toute la sortie »): the camera's compass is detected; back to the track, then Ctrl+Z
  await tab(page, 'Positions et sens').click()
  await page.locator('details[data-section="ride"] > summary').click()
  const source = page.getByRole('combobox', { name: 'Source du cap' })
  await expect(source).toHaveValue('device')
  await source.selectOption('track')
  await expect(source).toHaveValue('track')
  expect((await (await request.get(`/api/projects/${pid}`)).json()).heading_source).toBe('track')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect(source).toHaveValue('device')

  // a 360° folder cannot join the project: clear message in the import dialog
  await page.getByRole('button', { name: 'Importer', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'Importer des photos' })
  await dlg.locator('.fs-dir', { hasText: 'Sortie_test' }).click()
  await dlg.getByRole('button', { name: 'Ajouter ce dossier' }).click()
  await dlg.getByRole('button', { name: 'Importer', exact: true }).click()
  await expect(dlg).toContainText('photos plates')
  await expect(dlg).toContainText('360°')
})
