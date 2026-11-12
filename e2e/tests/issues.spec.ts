import type { Page } from '@playwright/test'
import { expect, newProject, openProject, rows, tab, test } from './helpers'

// Wide stop threshold: the simulated ride then has stops to sort
const STOPS = { stop_m: 15, stop_min: 3 }

// The step's tab shows its list once the points to check are loaded
async function openStops(page: Page) {
  const step = tab(page, 'Doublons et arrêts')
  await expect(step).toContainText('arrêts à trier')
  await step.click()
}

test('liste « À corriger » d\'une étape, puis fiche de la photo', async ({ page, request }) => {
  await newProject(request, 'Arrêts liste', STOPS)
  await openProject(page, 'Arrêts liste')
  await openStops(page)
  // the list « À corriger » is the content of the step's tab (no floating window)
  const panel = page.locator('.tab-body').getByRole('region', { name: /À corriger : Doublons et arrêts/ })
  await expect(panel).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panel.locator('.issues-group h4').first()).toContainText('Arrêts')
  await panel.locator('.issue-item').first().click()
  // the card comes above the list, in the same tab
  await expect(tab(page, 'Doublons et arrêts')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.tab-body .check-card')).toContainText('À corriger : Arrêt')
  await expect(page.locator('.check-card')).toContainText('Cause')
  await expect(panel).toBeVisible()
})

test('arrêt : ajuster les photos, comparer, tout exclure', async ({ page, request }) => {
  const pid = await newProject(request, 'Arrêts tri', STOPS)
  await openProject(page, 'Arrêts tri')
  await openStops(page)
  await page.locator('.issue-item').first().click()
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
