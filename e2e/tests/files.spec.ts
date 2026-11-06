import { expect, newProject, openProject, test } from './helpers'

test('import : navigation dans les sous-dossiers, photos listées pour information', async ({ page, request }) => {
  await request.post('/api/projects', { data: { name: 'Import vide' } })
  await page.goto('/')
  await page.locator('.project-name', { hasText: 'Import vide' }).click()
  await page.getByRole('button', { name: 'Importer', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'Importer des photos' })
  await dlg.locator('.fs-dir', { hasText: 'Sortie_test' }).click()
  await dlg.locator('.fs-dir', { hasText: 'sous-dossier' }).click()
  await dlg.locator('.fs-dir', { hasText: 'encore' }).click()
  await expect(dlg.locator('.fs-crumbs')).toContainText('encore')
  await dlg.locator('.fs-crumbs button', { hasText: 'Sortie_test' }).click() // back by the breadcrumb
  await dlg.locator('.fs-dir', { hasText: '100GOPRO' }).click()
  await expect(dlg.locator('.fs-file').first()).toContainText('.JPG')
  await dlg.getByRole('button', { name: 'Ajouter ce dossier' }).click()
  await expect(dlg.locator('.chosen')).toContainText('100GOPRO')
})
