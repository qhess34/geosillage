import { expect, newProject, openProject, photoNumber, pickOnTimeline, test } from './helpers'

test('ouvrir un projet, barre d\'étapes, navigation au clavier et par la timeline', async ({ page, request }) => {
  await newProject(request, 'Navigation')
  await openProject(page, 'Navigation')
  await expect(page.locator('.steps .step')).toHaveCount(7)
  await expect(page.locator('.step', { hasText: 'Import' })).toContainText('photos')

  const n = await pickOnTimeline(page, 0.5)
  expect(n).toBeGreaterThan(1)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => photoNumber(page)).toBe(n + 1)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => photoNumber(page)).toBe(n)
  // the Photo tab shows the heading and the camera orientation, explained
  await expect(page.getByRole('heading', { name: /Cap — sens de déplacement/i })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Orientation de la caméra/i })).toBeVisible()
})

test('aide des raccourcis : ? ouvre, Échap et ? ferment', async ({ page, request }) => {
  await newProject(request, 'Aide')
  await openProject(page, 'Aide')
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toHaveCount(0)
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toHaveCount(0)
})
