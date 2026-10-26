import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';
import {
  attachErrorCollectors,
  sweepInputs,
  sweepSelects,
  printReport,
} from './fuzz-helpers';

/**
 * FUZZ A — Vessel / Misc / Bunker / Notes.
 * Fills a realistic sample sheet (vessel FUGA + misc + bunker), then feeds
 * every field hostile payloads: letters ("abc"), symbols ("100$"),
 * groupings ("1,000"), spaces ("   "), empties, negatives, "12.5.3", "1e5".
 * Flags page errors, NaN/Infinity leaks, and junk kept verbatim.
 */
test.describe('Fuzz A — vessel/misc/bunker fields', () => {
  test('hostile payloads in every vessel/misc/bunker field', async ({ page }) => {
    test.setTimeout(600_000);
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);

    const { errors, setCurrent } = attachErrorCollectors(page);

    // Sample data: select vessel FUGA (hydrates the card).
    const search = page.getByPlaceholder('Search vessel...');
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.click();
    await search.fill('');
    await search.pressSequentially(SEEDS.vessel, { delay: 250 });
    await page
      .waitForResponse(
        (r) => r.url().includes('/vessels') && r.url().includes(`q=${SEEDS.vessel}`),
        { timeout: 20_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1500);
    await page
      .locator('div.absolute.z-50 button, div[class*="z-50"] button')
      .filter({ hasText: new RegExp(SEEDS.vessel, 'i') })
      .first()
      .click();
    await expect
      .poll(async () => page.locator('#v-vessel-dwt-_').inputValue(), { timeout: 30_000 })
      .not.toBe('');

    // Sample misc + bunker + notes.
    await page.locator('#v-misc-miscCost-_').fill('5000');
    await page.locator('#v-misc-canalCost1-_').fill('250000');
    await page.locator('#v-bunker-bobQuantity-vlsfo').fill('200');
    await page.locator('#v-bunker-vlsfoPrice-bob').fill('600');
    await page.getByPlaceholder(/add notes for this voyage/i).fill('fuzz baseline');

    const result = await sweepInputs(page, 'vessel+misc+bunker', page.locator('body'), setCurrent, errors, {
      skip: [/v-sequence/i, /v-cargo/i, /search charterer/i],
    });
    const selectCriticals = await sweepSelects(page, 'vessel+misc+bunker', page.locator('body'), setCurrent, errors);
    await writeFile(
      'test-results/fuzz-a.json',
      JSON.stringify({ ...result, selectCriticals }, null, 1),
    );
    await page.screenshot({ path: 'screenshots/fuzz-a-done.png' });
    printReport(result, selectCriticals);
  });
});
