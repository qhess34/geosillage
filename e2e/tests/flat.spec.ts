import { expect, openProject, pickOnTimeline, ridePath, test, waitJobs } from './helpers'

// Smartphone ride (flat pictures): the project type comes from the XMP tags of the pictures
test('projet plat : visionneuse sans 360°, direction de la caméra, autre type refusé', async ({ page, request }) => {
  const home = (await ridePath(request)).replace(/\/Sortie_test$/, '')
  const pid = (await (await request.post('/api/projects', { data: { name: 'Sortie plate' } })).json()).id as string
  await request.post(`/api/projects/${pid}/import`, { data: { paths: [`${home}/Sortie_plat`] } })
  await waitJobs(request, pid)
  expect((await (await request.get(`/api/projects/${pid}`)).json()).media).toBe('flat')

  await openProject(page, 'Sortie plate')
  const body = page.locator('.tab-body')
  await pickOnTimeline(page, 0.5)
  await expect(body.getByRole('heading', { name: 'Direction de la caméra' })).toBeVisible()
  await expect(body.getByRole('button', { name: 'Vue 360°' })).toHaveCount(0)
  await expect(body.getByRole('button', { name: 'À plat' })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Bilan' }).click()
  await expect(page.locator('table.summary')).toContainText('Plates')
  await expect(page.locator('table.summary')).toContainText('Intervalle médian')

  // a 360° folder cannot join the project: clear message in the import dialog
  await page.getByRole('button', { name: 'Importer', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'Importer des photos' })
  await dlg.locator('.fs-dir', { hasText: 'Sortie_test' }).click()
  await dlg.getByRole('button', { name: 'Ajouter ce dossier' }).click()
  await dlg.getByRole('button', { name: 'Importer', exact: true }).click()
  await expect(dlg).toContainText('photos plates')
  await expect(dlg).toContainText('360°')
})
