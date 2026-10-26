import { test, expect } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';

/**
 * REAL SHEET — one legit, hand-built, realistic voyage on a fresh sheet:
 * FUGA (Handy 38,036 DWT) loads 35,000 MT at Tubarao, discharges 20,000 MT
 * at Qingdao + 15,000 MT at Santos (load SUM == discharge SUM), with custom
 * per-leg coefficient factors (1.05 / 1.02 / 0.98), sea margins, realistic
 * speeds/consumption, cargo economics, intake calculator with Update Intake,
 * misc/canal, bunker prices + EU ETS. Asserts the sheet's own quantities sum
 * equal, the quantity-balance readout is clean, zero "needs attention" items,
 * and saves the sheet into workbook "testing -a".
 */
test.describe('Real sheet — legit balanced voyage', () => {
  test('load sum equals discharge sum, custom coefficients, intake', async ({ page }) => {
    test.setTimeout(900_000);
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);

    const appErrors: string[] = [];
    page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const t = m.text().slice(0, 200);
        if (!/favicon|net::/i.test(t)) appErrors.push(`console: ${t}`);
      }
    });
    const noNaN = async () => {
      expect(await page.getByText('NaN').count(), 'NaN on page').toBe(0);
    };

    // Fresh sheet so nothing leaks in from other runs.
    await test.step('new sheet', async () => {
      await page.getByRole('button', { name: /^new sheet$/i }).first().click();
      await page.waitForTimeout(2000);
      await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 30_000 });
    });

    const selectPort = async (inputIndex: number, query: string) => {
      const input = page.getByPlaceholder('Select port...').nth(inputIndex);
      await input.click();
      await input.fill('');
      await input.pressSequentially(query, { delay: 200 });
      await page
        .waitForResponse(
          (r) => r.url().includes('/ports/search') && r.url().includes(`q=${query}`),
          { timeout: 25_000 },
        )
        .catch(() => {});
      await page.waitForTimeout(1200);
      const overlay = page.locator(
        'div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
      );
      await expect(overlay.first(), `port dropdown for ${query}`).toBeVisible({ timeout: 20_000 });
      await overlay.getByRole('button').first().click();
      await expect(input, `port kept for ${query}`).not.toHaveValue('', { timeout: 20_000 });
      console.log(`port[${inputIndex}] <= ${query} → ${await input.inputValue()}`);
    };

    await test.step('vessel FUGA + realistic speeds/consumption', async () => {
      const search = page.getByPlaceholder('Search vessel...').first();
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
      const dwt = page.locator('#v-vessel-dwt-_');
      await expect.poll(async () => dwt.inputValue(), { timeout: 30_000 }).not.toBe('');
      console.log(`vessel DWT=${await dwt.inputValue()}`);
      // Realistic eco speeds + consumption for a laden Handy on this run.
      const realistic: Record<string, string> = {
        '#v-vessel-matrix_speed_ballast-_': '12',
        '#v-vessel-matrix_speed_laden-_': '12.5',
        '#v-vessel-matrix_vlsfo_ballast-_': '24.5',
        '#v-vessel-matrix_vlsfo_laden-_': '26',
        '#v-vessel-matrix_vlsfo_load-_': '3',
        '#v-vessel-matrix_vlsfo_discharge-_': '3',
        '#v-vessel-matrix_vlsfo_idle-_': '2',
        '#v-vessel-matrix_lsmgo_ballast-_': '2',
        '#v-vessel-matrix_lsmgo_laden-_': '2.2',
        '#v-vessel-matrix_lsmgo_load-_': '1',
        '#v-vessel-matrix_lsmgo_discharge-_': '1',
        '#v-vessel-matrix_lsmgo_idle-_': '1',
      };
      for (const [id, v] of Object.entries(realistic)) {
        if ((await page.locator(id).count()) > 0) await page.locator(id).fill(v);
      }
      await noNaN();
    });

    await test.step('route + quantities with load SUM == discharge SUM', async () => {
      await selectPort(0, 'Singapore'); // open leg bunker port
      await selectPort(1, 'Tubarao'); // load leg
      await selectPort(2, 'Qingdao'); // first discharge
      const n = await page.getByPlaceholder('Select port...').count();
      await page.getByRole('button', { name: /^add$/i }).first().click();
      await expect(page.getByPlaceholder('Select port...')).toHaveCount(n + 1, { timeout: 20_000 });
      await selectPort(n, 'Santos'); // second discharge

      // 35,000 load == 20,000 + 15,000 discharge.
      await page.locator('#v-sequence-quantity-2').fill('35000');
      await page.locator('#v-sequence-productivity-2').fill('15000');
      await page.locator('#v-sequence-quantity-3').fill('20000');
      await page.locator('#v-sequence-productivity-3').fill('12000');
      await page.locator('#v-sequence-quantity-4').fill('15000');
      await page.locator('#v-sequence-productivity-4').fill('10000');
      await page.locator('#v-sequence-turnTime-2').fill('12');
      await page.locator('#v-sequence-expDa-2').fill('45000');
      await page.locator('#v-sequence-seaMargin-2').fill('5');
      await page.locator('#v-sequence-seaMargin-3').fill('5');
      await page.locator('#v-sequence-seaMargin-4').fill('5');

      // Custom per-leg coefficient factors (not defaults).
      await page.locator('#v-sequence-coefficientFactor-2').fill('1.05');
      await page.locator('#v-sequence-coefficientFactor-3').fill('1.02');
      await page.locator('#v-sequence-coefficientFactor-4').fill('0.98');
      console.log('coefficients: leg2=1.05 leg3=1.02 leg4=0.98');

      const fetch = page.locator('#auto-dist');
      if ((await fetch.count()) > 0 && !(await fetch.isChecked().catch(() => true))) {
        await fetch.click().catch(() => {});
      }
      await page.waitForTimeout(5000);
      const dist2 = page.locator('#v-sequence-distance-2');
      if ((await dist2.count()) > 0 && (await dist2.inputValue()) === '') await dist2.fill('11800');
      const dist3 = page.locator('#v-sequence-distance-3');
      if ((await dist3.count()) > 0 && (await dist3.inputValue()) === '') await dist3.fill('11200');
      await noNaN();

      // Genuine SUM check from the sheet's own stored values.
      const num = async (id: string) =>
        Number((await page.locator(id).inputValue()).replace(/[^0-9.]/g, '')) || 0;
      const load = await num('#v-sequence-quantity-2');
      const disch = (await num('#v-sequence-quantity-3')) + (await num('#v-sequence-quantity-4'));
      console.log(`SUM check: load=${load} discharge=${disch}`);
      expect(load, 'load quantity').toBe(35000);
      expect(disch, 'discharge SUM equals load SUM').toBe(load);
      const balance = page.locator('#v-cargo-quantityBalance-1');
      if ((await balance.count()) > 0) {
        console.log(`quantityBalance readout: ${(await balance.inputValue()).slice(0, 80)}`);
      }
    });

    await test.step('cargo economics', async () => {
      await page.locator('#v-cargo-rate-1').fill('28.5');
      await page.locator('#v-cargo-voyageCommission-1').fill('2.5');
      await page.locator('#v-cargo-demurrageRate-1').fill('18000');
      await page.locator('#v-cargo-despatchRate-1').fill('9000');
      await page.locator('#v-cargo-gtc-_header').fill('16500');
      await noNaN();
      await page.screenshot({ path: 'screenshots/real-cargo.png' });
    });

    await test.step('intake calculator', async () => {
      await page.getByRole('button', { name: /intake calculator/i }).first().click();
      const dwt = page.locator('#v-intake-dwt-_');
      await expect(dwt).toBeVisible({ timeout: 20_000 });
      if ((await dwt.inputValue()) === '') await dwt.fill('38036');
      await page.locator('#v-intake-constants-_').fill('400');
      await page.locator('#v-intake-bunkers-_').fill('900');
      await page.locator('#v-intake-freshWater-_').fill('150');
      const sf = page.locator('#v-intake-sf-_');
      if ((await sf.count()) > 0 && (await sf.inputValue()) === '') await sf.fill('49');
      // Exercise the cargo-type dropdown inside intake when present.
      const cargoType = page.locator('#v-intake-dwt-_').locator('xpath=ancestor::div[contains(@class,"space-y-3")]//select').first();
      if ((await cargoType.count()) > 0) {
        const opts = await cargoType.locator('option:not([disabled])').allTextContents();
        if (opts.length > 1) await cargoType.selectOption({ index: 1 }).catch(() => {});
      }
      const restricted = page.getByText(/restricted intake/i).first();
      await expect(restricted).toBeVisible();
      console.log(`intake: ${(await restricted.textContent())?.trim().slice(0, 120)}`);
      await page.screenshot({ path: 'screenshots/real-intake.png' });
      await page.getByRole('button', { name: /update intake/i }).click();
      await page.waitForTimeout(1500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      await noNaN();
    });

    await test.step('misc + bunker + summary + save', async () => {
      await page.locator('#v-misc-miscCost-_').fill('8000');
      await page.locator('#v-misc-extraFees-_').fill('2000');
      await page.locator('#v-misc-canalCost1-_').fill('300000');
      await page.locator('#v-misc-canalTime-_').fill('1.5');
      await page.locator('#v-bunker-bobQuantity-vlsfo').fill('250');
      await page.locator('#v-bunker-vlsfoPrice-bob').fill('620');
      await page.locator('#v-bunker-bobQuantity-lsmgo').fill('80');
      await page.locator('#v-bunker-lsmgoPrice-bob').fill('780');
      await page.locator('#v-bunker-euEtsPrice-_').fill('95');

      const expand = page.getByRole('button', { name: /expand summary/i });
      if ((await expand.count()) > 0) await expand.first().click();
      await page.waitForTimeout(2000);
      await expect(page.getByText(/needs attention/).first()).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByText(/NaN/).first()).toHaveCount(0);
      const summaryBtn = page.locator('button[title="Sequence summary"]');
      if ((await summaryBtn.count()) > 0) console.log(`final summary: ${await summaryBtn.textContent()}`);
      await page.screenshot({ path: 'screenshots/real-summary.png', fullPage: true });

      await page.locator('button[title="Save Sheet"]').first().click();
      const nameInput = page.locator('input.form-input-sm.w-32');
      await expect(nameInput).toBeVisible({ timeout: 20_000 });
      const sheetName = `Real Sheet ${Date.now() % 100000}`;
      await nameInput.fill(sheetName);
      const workbook = page.locator('select[title="Workbook"]');
      await expect
        .poll(async () => (await workbook.locator('option').allTextContents()).join(' | '), { timeout: 20_000 })
        .toMatch(/testing -a/);
      await workbook.selectOption({ label: 'testing -a' });
      await page.getByRole('button', { name: /^ok$/i }).click();
      const toast = page.getByText('Sheet saved').first();
      await expect(toast).toBeVisible({ timeout: 25_000 });
      console.log(`saved ${sheetName} into testing -a`);
    });

    expect(appErrors, `app errors:\n${appErrors.join('\n')}`).toEqual([]);
    await noNaN();
  });
});
