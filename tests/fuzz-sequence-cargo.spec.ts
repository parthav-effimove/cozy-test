import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';
import {
  attachErrorCollectors,
  sweepInputs,
  printReport,
} from './fuzz-helpers';

/**
 * FUZZ B — Sequence / Cargo.
 * Builds a sample voyage (vessel FUGA + port Riau on the load leg + rate +
 * quantity + GTC), then feeds every sequence/cargo field hostile payloads:
 * letters ("abc"), symbols ("100$"), groupings ("1,000"), spaces ("   "),
 * empties ("" = clear + recalc), negatives, "12.5.3", "1e5".
 * The "" payload is the per-field empty-and-recalculate case; "   " checks
 * the parser treats blanks as empty. Flags page errors and NaN leaks.
 */
test.describe('Fuzz B — sequence/cargo fields', () => {
  test('hostile payloads in every sequence/cargo field', async ({ page }) => {
    test.setTimeout(600_000);
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);

    const { errors, setCurrent } = attachErrorCollectors(page);

    // Sample voyage: vessel FUGA.
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

    // Sample voyage: port Riau on the load leg.
    const loadPort = page.getByPlaceholder('Select port...').nth(1);
    await loadPort.click();
    await loadPort.fill('');
    await loadPort.pressSequentially(SEEDS.port, { delay: 250 });
    await page
      .waitForResponse(
        (r) => r.url().includes('/ports/search') && r.url().includes(`q=${SEEDS.port}`),
        { timeout: 20_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1500);
    const overlay = page.locator(
      'div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
    );
    if ((await overlay.first().count()) > 0) {
      await overlay.getByRole('button').first().click();
    }

    // Sample cargo: quantity on the leg + rate + GTC.
    if ((await page.locator('#v-sequence-quantity-2').count()) > 0) {
      await page.locator('#v-sequence-quantity-2').fill('30000');
    }
    await page.locator('#v-cargo-rate-1').fill('45');
    await page.locator('#v-cargo-gtc-_header').fill('15000');
    await page.screenshot({ path: 'screenshots/fuzz-b-sample.png' });

    const result = await sweepInputs(page, 'sequence+cargo', page.locator('body'), setCurrent, errors, {
      skip: [/v-vessel/i, /v-misc/i, /v-bunker/i, /add notes/i, /search vessel/i],
    });
    await writeFile('test-results/fuzz-b.json', JSON.stringify(result, null, 1));
    await page.screenshot({ path: 'screenshots/fuzz-b-done.png' });
    printReport(result);
  });
});
