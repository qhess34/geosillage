import type { Page } from '@playwright/test'
import { expect, newProject, openProject, rows, test } from './helpers'

// Wide stop threshold: the simulated ride then has stops to sort
const STOPS = { stop_m: 15, stop_min: 3 }

// The step opens the list once the points to check are loaded (before, it opens the Bilan)
async function openStops(page: Page) {
  const step = page.locator('.step', { hasText: 'Doublons et arrêts' })
  await expect(step).toContainText('arrêts à trier')
  await step.click()
}

test('liste « À corriger » d\'une étape, puis fiche de la photo', async ({ page, request }) => {
  await newProject(request, 'Arrêts liste', STOPS)
  await openProject(page, 'Arrêts liste')
  await openStops(page)
  const panel = page.getByRole('dialog', { name: /À corriger : Doublons et arrêts/ })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.issues-group h4').first()).toContainText('Arrêts')
  await panel.locator('.issue-item').first().click()
  await expect(page.locator('.check-card')).toContainText('À corriger : Arrêt')
  await expect(page.locator('.check-card')).toContainText('Cause')
})

test('arrêt : ajuster les photos, comparer, tout exclure', async ({ page, request }) => {
  const pid = await newProject(request, 'Arrêts tri', STOPS)
  await openProject(page, 'Arrêts tri')
  await openStops(page)
  await page.locator('.issue-item').first().click()
  await page.keyboard.press('Escape') // closes the list, keeps the card
  const card = page.locator('.check-card')
  const title = card.locator('.stop-range .row strong')
  const [a, b] = (await title.innerText()).match(/\d+/g)!.map(Number)
  // end + 1 (Fin ▶), then start + 1 (Début ▶)
  await card.locator('.stop-range .btn-group').nth(1).locator('button').nth(1).click()
  await card.locator('.stop-range .btn-group').nth(0).locator('button').nth(1).click()
  await expect(title).toHaveText(`Photos ${a + 1} → ${b + 1}`)
  const n = b - a + 1
  await card.getByRole('button', { name: `Comparer ces ${n} photos` }).click()
  const cmp = page.getByRole('dialog', { name: /Comparer les photos de l'arrêt/ })
  await expect(cmp.locator('h2')).toHaveText(`Arrêt : photos ${a + 1} → ${b + 1}`)
  await cmp.getByRole('button', { name: 'Tout désélectionner' }).click()
  await cmp.getByRole('button', { name: /Exclure les \d+ photos \(aucune gardée\)/ }).click()
  await expect(page.locator('.toast')).toContainText('exclue')
  const excluded = (await rows(request, pid)).filter((r) => r.idx >= a && r.idx <= b && r.excluded)
  expect(excluded.length).toBe(n)
})
