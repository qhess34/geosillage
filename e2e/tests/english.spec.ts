import { expect, newProject, openProject, pickOnTimeline, test } from './helpers'

test.use({ locale: 'en-GB' })

test('default sequence name is shown in English', async ({ page, request }) => {
  await newProject(request, 'English names')
  await openProject(page, 'English names')
  await pickOnTimeline(page, 0.2)
  await page.keyboard.press('d')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('f')
  await page.locator('.tab', { hasText: 'Sequences' }).click()
  await expect(page.locator('.seq-name').first()).toHaveText('Sequence 1')
})
