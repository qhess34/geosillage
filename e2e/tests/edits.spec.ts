import { expect, newProject, openProject, photoNumber, pickOnTimeline, rows, tab, test } from './helpers'

test('séquence créée avec D puis F, annulée avec Ctrl+Z', async ({ page, request }) => {
  const pid = await newProject(request, 'Séquences')
  await openProject(page, 'Séquences')
  await pickOnTimeline(page, 0.2)
  await page.keyboard.press('d')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('f')
  await tab(page, 'Séquences').click()
  await expect(page.locator('.tab-body .seq-name')).toHaveCount(1)
  expect((await rows(request, pid)).filter((r) => r.sequence_id != null).length).toBe(11)
  await page.keyboard.press('Control+z')
  await expect(page.locator('.tab-body .seq-name')).toHaveCount(0)
})

test('exclusion avec X', async ({ page, request }) => {
  const pid = await newProject(request, 'Exclusion')
  await openProject(page, 'Exclusion')
  const n = await pickOnTimeline(page, 0.5)
  await page.keyboard.press('x')
  await expect.poll(async () => (await rows(request, pid)).find((r) => r.idx === n - 1)?.excluded).toBe(1)
  await expect.poll(() => photoNumber(page)).toBe(n + 1) // excluded: the next photo is shown
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await rows(request, pid)).find((r) => r.idx === n - 1)?.excluded).toBe(0)
})

test('timeline : photos exclues masquées tant que la case « Afficher les exclues » est décochée', async ({ page, request }) => {
  const pid = await newProject(request, 'Timeline exclues')
  // the first half of the ride excluded
  await request.post(`/api/projects/${pid}/photos/exclude`, { data: { start_idx: 0, end_idx: 79 } })
  await openProject(page, 'Timeline exclues')
  const exc = page.locator('label', { hasText: 'Afficher les exclues' }).locator('input')
  await expect(exc).not.toBeChecked()
  expect(await pickOnTimeline(page, 0.05)).toBeGreaterThan(80) // hidden: the strip starts with the kept photos
  await exc.check()
  // shown again (as holes): the same place of the strip is now one of the excluded photos
  const cv = page.locator('canvas.timeline')
  await cv.click({ position: { x: (await cv.boundingBox())!.width * 0.05, y: 30 } })
  await expect.poll(() => photoNumber(page)).toBeLessThan(80)
})

test('réglages : un seuil hors limites est refusé avec un message en français', async ({ page, request }) => {
  await newProject(request, 'Réglages')
  await openProject(page, 'Réglages')
  await page.getByRole('button', { name: /Réglages/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Réglages' })
  await dlg.getByLabel('…à moins de').fill('500')
  // the « Points à vérifier » section has its own Enregistrer button
  await dlg.locator('div', { has: page.getByRole('heading', { name: 'Points à vérifier (ce projet)' }) }).last().getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.locator('.error.banner')).toContainText('Réglage invalide')
})
