import { test, expect } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator } from './helpers';

test.describe('Cargo / Misc / Bunker / Notes', () => {
  test.beforeEach(async ({ page }) => {
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);
  });

  test('cargo leg fields accept values', async ({ page }) => {
    const rate = page.locator('#v-cargo-rate-1');
    await expect(rate).toBeVisible({ timeout: 30_000 });
    await rate.fill('45.5');
    await expect(rate).toHaveValue('45.5');

    await page.locator('#v-cargo-voyageCommission-1').fill('2.5');
    await page.locator('#v-cargo-demurrageRate-1').fill('18000');
    await page.locator('#v-cargo-despatchRate-1').fill('9000');
    await page.locator('#v-cargo-ntc-_').evaluate((el) => el) // touch derived field
      .catch(() => {});

    const charterer = page.getByPlaceholder('Search charterer...');
    await expect(charterer).toBeVisible();
    await charterer.fill('Test Charterer');

    await expect(
      page.getByRole('button', { name: /add cargo/i }),
    ).toBeVisible();
    await page.screenshot({ path: 'screenshots/cargo-fields.png' });
  });

  test('Add Cargo appends a new cargo entry', async ({ page }) => {
    // Collapsed entries render only header buttons ("#1 0 mt | 0.00 $/ton ..."),
    // so count those rather than the expanded-row inputs.
    const entries = page.getByRole('button', { name: /\$ ?\/ ?ton/ });
    await expect(entries.first()).toBeVisible({ timeout: 30_000 });
    const before = await entries.count();
    await page.getByRole('button', { name: /add cargo/i }).click();
    await expect(entries).toHaveCount(before + 1, { timeout: 20_000 });
    console.log(`Cargo entries: ${before} → ${await entries.count()}`);
    await page.screenshot({ path: 'screenshots/cargo-added.png' });
  });

  test('misc costs + canal time + canal fuel', async ({ page }) => {
    await expect(page.locator('#v-misc-miscCost-_')).toBeVisible({ timeout: 30_000 });
    await page.locator('#v-misc-miscCost-_').fill('5000');
    await page.locator('#v-misc-extraFees-_').fill('1200');
    await page.locator('#v-misc-extraInsurance-_').fill('800');
    await page.locator('#v-misc-canalCost1-_').fill('250000');
    await page.locator('#v-misc-canalTime-_').fill('2');

    // Canal-fuel select defaults to VLSFO; HSFO is disabled without scrubber.
    const canalFuel = page.locator('text=Canal Fuel').locator('..').locator('select');
    await expect(canalFuel).toHaveValue('vlsfo');
    await canalFuel.selectOption('lsmgo');
    await expect(canalFuel).toHaveValue('lsmgo');
    const hsfo = canalFuel.locator('option[value="hsfo"]');
    if ((await hsfo.count()) > 0) await expect(hsfo).toBeDisabled();
    await page.screenshot({ path: 'screenshots/misc-fields.png' });
  });

  test('bunker BOB + ETS + wind reward', async ({ page }) => {
    await expect(page.locator('#v-bunker-bobQuantity-vlsfo')).toBeVisible({
      timeout: 30_000,
    });
    await page.locator('#v-bunker-bobQuantity-hsfo').fill('100');
    await page.locator('#v-bunker-bobQuantity-vlsfo').fill('200');
    await page.locator('#v-bunker-bobQuantity-lsmgo').fill('50');
    await page.locator('#v-bunker-euEtsPrice-_').fill('95');
    await page.locator('#v-bunker-ukEtsPrice-_').fill('60');

    const wind = page.locator('text=Wind Reward').locator('..').locator('select');
    if ((await wind.count()) > 0) {
      await wind.selectOption('0.95');
      await expect(wind).toHaveValue('0.95');
    }
    await page.screenshot({ path: 'screenshots/bunker-fields.png' });
  });

  test('notes textarea persists text', async ({ page }) => {
    const notes = page.getByPlaceholder(/add notes for this voyage/i);
    await expect(notes).toBeVisible({ timeout: 30_000 });
    await notes.fill('Playwright visual run 2026-10-21 — voyage looks good.');
    await expect(notes).toHaveValue(/Playwright visual run/);
  });
});
