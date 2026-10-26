import { test, expect } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator } from './helpers';

/**
 * Full visual pass: one screenshot per calculator card + full page.
 * Open with: npm run test:chrome (real Chrome, headed, slow-mo).
 */
test.describe('Visual — full voyage page', () => {
  test.beforeEach(async ({ page }) => {
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);
  });

  test('capture every card + full page', async ({ page }) => {
    await expect(page.getByPlaceholder('Search vessel...')).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(1000);

    // Viewport screenshot first (what the user sees on load).
    await page.screenshot({ path: 'screenshots/00-load.png' });

    // Scroll through the long sheet so lazy content renders.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Full-page stitched screenshot.
    await page.screenshot({ path: 'screenshots/01-full-page.png', fullPage: true });

    // Per-card screenshots by vertical section header.
    for (const name of ['Vessel', 'Sequence', 'Cargo', 'Bunker', 'Notes', 'Miscellaneous']) {
      const header = page.getByRole('button', { name, exact: false }).first();
      if ((await header.count()) === 0) continue;
      const card = header.locator('xpath=ancestor::div[contains(@class,"calc-card-row")][1]');
      if ((await card.count()) > 0) {
        await card.first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await card.first().screenshot({
          path: `screenshots/card-${name.toLowerCase()}.png`,
        });
      }
    }

    // No console errors allowed on clean load.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    expect(errors.filter((e) => !/favicon|net::/i.test(e))).toEqual([]);
  });
});
