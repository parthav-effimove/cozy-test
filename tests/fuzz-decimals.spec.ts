import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';
import {
  attachErrorCollectors,
  sweepDecimalsIds,
  DECIMAL_PAYLOADS,
  printReport,
} from './fuzz-helpers';

/**
 * FUZZ C — decimal torture (fast, scoped).
 * Builds a sample voyage (FUGA + Riau + quantity + rate + GTC) so computed
 * outputs exist, then feeds 14 calc-critical numeric fields every decimal
 * torture payload: infinite/over-precision decimals (27–30dp), float traps
 * (2.675, 0.30000000000000004), locale commas (12,5), dot variants (.5, 5.,
 * 123.), exponents, double extremes (2^53+1, max double, min subnormal),
 * padded and empty values. ~308 cases, ~2 min headless.
 * Critical: page errors, NaN/Infinity in computed outputs.
 * Warning (non-failing): unrounded >6dp leaks, >10dp stored.
 */
test.describe('Fuzz C — decimal torture on calc-critical fields', () => {
  test('infinite decimals never break calculations', async ({ page }) => {
    test.setTimeout(600_000);
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);

    const { errors, setCurrent } = attachErrorCollectors(page);

    // Sample voyage so sea-time/summary outputs exist.
    const search = page.getByPlaceholder('Search vessel...');
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.click();
    await search.fill('');
    await search.pressSequentially(SEEDS.vessel, { delay: 200 });
    await page
      .waitForResponse(
        (r) => r.url().includes('/vessels') && r.url().includes(`q=${SEEDS.vessel}`),
        { timeout: 20_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1200);
    await page
      .locator('div.absolute.z-50 button, div[class*="z-50"] button')
      .filter({ hasText: new RegExp(SEEDS.vessel, 'i') })
      .first()
      .click();
    await expect
      .poll(async () => page.locator('#v-vessel-dwt-_').inputValue(), { timeout: 30_000 })
      .not.toBe('');
    await page.locator('#v-vessel-matrix_speed_ballast-_').fill('12');
    await page.locator('#v-vessel-matrix_speed_laden-_').fill('12.5');

    const loadPort = page.getByPlaceholder('Select port...').nth(1);
    await loadPort.click();
    await loadPort.fill('');
    await loadPort.pressSequentially(SEEDS.port, { delay: 200 });
    await page
      .waitForResponse(
        (r) => r.url().includes('/ports/search') && r.url().includes(`q=${SEEDS.port}`),
        { timeout: 20_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1200);
    const overlay = page.locator(
      'div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
    );
    if ((await overlay.first().count()) > 0) {
      await overlay.getByRole('button').first().click();
    }
    if ((await page.locator('#v-sequence-quantity-2').count()) > 0) {
      await page.locator('#v-sequence-quantity-2').fill('30000');
    }
    await page.locator('#v-cargo-rate-1').fill('45');
    await page.locator('#v-cargo-gtc-_header').fill('15000');
    await page.screenshot({ path: 'screenshots/fuzz-c-sample.png' });

    // Scoped to calc-critical fields only — every payload hits a field that
    // feeds sea time / money math. Covers vessel, sequence, cargo, misc,
    // bunker, intake-adjacent costs: infinite decimals everywhere that matters.
    const IDS = [
      '#v-vessel-matrix_speed_ballast-_',
      '#v-vessel-matrix_speed_laden-_',
      '#v-vessel-matrix_vlsfo_laden-_',
      '#v-sequence-quantity-2',
      '#v-sequence-productivity-2',
      '#v-sequence-distance-2',
      '#v-cargo-rate-1',
      '#v-cargo-gtc-_header',
      '#v-cargo-voyageCommission-1',
      '#v-cargo-demurrageRate-1',
      '#v-misc-miscCost-_',
      '#v-misc-canalCost1-_',
      '#v-bunker-bobQuantity-vlsfo',
      '#v-bunker-vlsfoPrice-bob',
    ];
    console.log(`DECIMAL payloads: ${DECIMAL_PAYLOADS.length}, fields: ${IDS.length}`);

    const result = await sweepDecimalsIds(page, 'decimals', IDS, setCurrent, errors);
    await writeFile('test-results/fuzz-c.json', JSON.stringify(result, null, 1));
    await page.screenshot({ path: 'screenshots/fuzz-c-done.png' });
    printReport(result);
  });
});
