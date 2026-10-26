import { test, expect, Page } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';

/**
 * FULL VOYAGE — builds a complete sheet end to end on a fresh sheet:
 * vessel + speeds/consumption, 4 real bulk ports (open/load/disch/disch),
 * Repos leg, cargo #2 with demurrage/despatch, intake calculator,
 * misc/canal, bunker, voyage summary, save. Fails on page errors or NaN.
 */
test.describe('Full voyage — complete sheet with real ports', () => {
  test('build, calculate, summarize and save a full sheet', async ({ page }) => {
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

    const selectPort = async (inputIndex: number, query: string) => {
      const input = page.getByPlaceholder('Select port...').nth(inputIndex);
      await input.click();
      await input.fill('');
      await input.pressSequentially(query, { delay: 250 });
      await page
        .waitForResponse(
          (r) => r.url().includes('/ports/search') && r.url().includes(`q=${query}`),
          { timeout: 25_000 },
        )
        .catch(() => {});
      await page.waitForTimeout(1500);
      const overlay = page.locator(
        'div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
      );
      await expect(overlay.first(), `port dropdown for ${query}`).toBeVisible({ timeout: 20_000 });
      await overlay.getByRole('button').first().click();
      await expect(input, `port kept for ${query}`).not.toHaveValue('', { timeout: 20_000 });
      const val = await input.inputValue();
      console.log(`port[${inputIndex}] <= ${query} → ${val}`);
      return val;
    };

    await test.step('vessel + speeds + consumption', async () => {
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
      const dwt = page.locator('#v-vessel-dwt-_');
      await expect.poll(async () => dwt.inputValue(), { timeout: 30_000 }).not.toBe('');
      const dwtNum = Number((await dwt.inputValue()).replace(/[^0-9.]/g, '')) || 38036;
      console.log(`vessel DWT=${await dwt.inputValue()} (num=${dwtNum})`);

      await page.locator('#v-vessel-matrix_speed_ballast-_').fill('12');
      await page.locator('#v-vessel-matrix_speed_laden-_').fill('12.5');
      await page.locator('#v-vessel-matrix_vlsfo_ballast-_').fill('24.5');
      await page.locator('#v-vessel-matrix_vlsfo_laden-_').fill('26');
      await page.locator('#v-vessel-matrix_vlsfo_load-_').fill('3');
      await page.locator('#v-vessel-matrix_vlsfo_discharge-_').fill('3');
      await page.locator('#v-vessel-matrix_vlsfo_idle-_').fill('2');
      await page.locator('#v-vessel-matrix_lsmgo_ballast-_').fill('2');
      await page.locator('#v-vessel-matrix_lsmgo_laden-_').fill('2.2');
      await page.locator('#v-vessel-matrix_lsmgo_load-_').fill('1');
      await page.locator('#v-vessel-matrix_lsmgo_discharge-_').fill('1');
      await page.locator('#v-vessel-matrix_lsmgo_idle-_').fill('1');
      await noNaN();
    });

    await test.step('sequence — 4 real bulk ports', async () => {
      await selectPort(0, 'Singapore');
      await selectPort(1, 'Tubarao');
      await selectPort(2, 'Qingdao');

      // Second discharge leg via Add.
      const ports = page.getByPlaceholder('Select port...');
      const before = await ports.count();
      await page.getByRole('button', { name: /^add$/i }).first().click();
      await expect(page.getByPlaceholder('Select port...')).toHaveCount(before + 1, {
        timeout: 20_000,
      });
      await selectPort(before, 'Santos');

      // Cargo quantities + handling on the load/disch legs. Total load must
      // stay under vessel DWT (else "cannot exceed DWT" blocks the summary).
      const dwtNow = Number((await page.locator('#v-vessel-dwt-_').inputValue()).replace(/[^0-9.]/g, '')) || 38036;
      const safeQty = String(Math.max(5000, Math.min(31400, Math.floor(dwtNow - 2000))));
      console.log(`safeQty=${safeQty} (capped by DWT)`);
      if ((await page.locator('#v-sequence-quantity-2').count()) > 0) {
        await page.locator('#v-sequence-quantity-2').fill(safeQty);
      }
      if ((await page.locator('#v-sequence-productivity-2').count()) > 0) {
        await page.locator('#v-sequence-productivity-2').fill('15000');
      }
      // Discharging rates are required on every disch leg.
      for (const id of ['#v-sequence-productivity-3', '#v-sequence-productivity-4']) {
        if ((await page.locator(id).count()) > 0) {
          await page.locator(id).fill('12000');
        }
      }
      if ((await page.locator('#v-sequence-turnTime-2').count()) > 0) {
        await page.locator('#v-sequence-turnTime-2').fill('12');
      }
      if ((await page.locator('#v-sequence-expDa-2').count()) > 0) {
        await page.locator('#v-sequence-expDa-2').fill('45000');
      }

      // Distances: try auto-fetch, fall back to manual legs.
      const fetch = page.locator('#auto-dist');
      if ((await fetch.count()) > 0 && !(await fetch.isChecked().catch(() => true))) {
        await fetch.click().catch(() => {});
      }
      await page.waitForTimeout(5000);
      const dist2 = page.locator('#v-sequence-distance-2');
      if ((await dist2.count()) > 0 && (await dist2.inputValue()) === '') {
        await dist2.fill('10500');
      }
      const dist3 = page.locator('#v-sequence-distance-3');
      if ((await dist3.count()) > 0 && (await dist3.inputValue()) === '') {
        await dist3.fill('1200');
      }
      await noNaN();
      await page.screenshot({ path: 'screenshots/full-sequence.png' });
    });

    await test.step('repos leg', async () => {
      const rowsBefore = await page.getByPlaceholder('Select port...').count();
      await page.getByRole('button', { name: /^repos$/i }).first().click();
      await expect(page.getByPlaceholder('Select port...')).toHaveCount(rowsBefore + 1, {
        timeout: 20_000,
      });
      const reposType = await page.getByText('Repos', { exact: true }).count();
      console.log(`repos rows on sheet: ${reposType}`);
      expect(reposType).toBeGreaterThan(0);
      await selectPort(rowsBefore, 'Durban');
      await noNaN();
    });

    await test.step('cargo — second cargo + demurrage/despatch', async () => {
      await page.getByRole('button', { name: /add cargo/i }).click();
      await expect(page.getByRole('button', { name: /\$ ?\/ ?ton/ })).toHaveCount(2, {
        timeout: 20_000,
      });
      await page.locator('#v-cargo-rate-1').fill('24.5');
      await page.locator('#v-cargo-voyageCommission-1').fill('2.5');
      await page.locator('#v-cargo-demurrageRate-1').fill('18000');
      await page.locator('#v-cargo-despatchRate-1').fill('9000');
      await page.locator('#v-cargo-tcCommission-1').fill('1.5');
      await page.locator('#v-cargo-gtc-_header').fill('16000');
      // Second cargo row requires its own Rate etc, else summary flags it.
      if ((await page.locator('#v-cargo-rate-2').count()) > 0) {
        await page.locator('#v-cargo-rate-2').fill('22.5');
        await page.locator('#v-cargo-voyageCommission-2').fill('2.5');
        await page.locator('#v-cargo-demurrageRate-2').fill('17000');
        await page.locator('#v-cargo-despatchRate-2').fill('8500');
      }
      await noNaN();
      await page.screenshot({ path: 'screenshots/full-cargo.png' });
    });

    await test.step('intake calculator', async () => {
      await page.getByRole('button', { name: /intake calculator/i }).first().click();
      const dwt = page.locator('#v-intake-dwt-_');
      await expect(dwt).toBeVisible({ timeout: 20_000 });
      if ((await dwt.inputValue()) === '') await dwt.fill('38036');
      await page.locator('#v-intake-constants-_').fill('400');
      await page.locator('#v-intake-bunkers-_').fill('900');
      await page.locator('#v-intake-freshWater-_').fill('150');
      const cargoType = page.locator('#v-intake-dwt-_').locator('xpath=ancestor::div[contains(@class,"space-y-3")]//select').first();
      if ((await cargoType.count()) > 0) {
        const opts = await cargoType.locator('option:not([disabled])').allTextContents();
        if (opts.length > 1) await cargoType.selectOption({ index: 1 }).catch(() => {});
      }
      const sf = page.locator('#v-intake-sf-_');
      if ((await sf.count()) > 0 && (await sf.inputValue()) === '') await sf.fill('49');
      await page.screenshot({ path: 'screenshots/full-intake.png' });

      const restricted = page.getByText(/restricted intake/i).first();
      await expect(restricted).toBeVisible();
      const intakeText = await page.locator('div[role="dialog"]').first().textContent().catch(() => '');
      expect(intakeText ?? '').not.toMatch(/NaN/);

      await page.getByRole('button', { name: /update intake/i }).click();
      await page.waitForTimeout(1500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      await noNaN();
    });

    await test.step('balance cargo quantities load = discharge', async () => {
      // Summary requires per-cargo load total to equal discharge total, so
      // split the load leg evenly across the disch legs (copying the full
      // qty onto each would double-count and trip the DWT cap too).
      const loadQty = await page.locator('#v-sequence-quantity-2').inputValue();
      const total = Number(String(loadQty).replace(/[^0-9.]/g, '')) || 0;
      console.log(`load quantity: ${loadQty}`);
      const legs: string[] = [];
      for (const id of ['#v-sequence-quantity-3', '#v-sequence-quantity-4']) {
        if ((await page.locator(id).count()) > 0) legs.push(id);
      }
      let assigned = 0;
      for (let k = 0; k < legs.length; k++) {
        const share = k === legs.length - 1 ? total - assigned : Math.floor(total / legs.length);
        assigned += share;
        await page.locator(legs[k]).fill(String(share));
      }
      await noNaN();
    });

    await test.step('misc + bunker + voyage summary + save', async () => {
      await page.locator('#v-misc-miscCost-_').fill('8000');
      await page.locator('#v-misc-extraFees-_').fill('2000');
      await page.locator('#v-misc-canalCost1-_').fill('300000');
      await page.locator('#v-misc-canalTime-_').fill('1.5');
      await page.locator('#v-bunker-bobQuantity-vlsfo').fill('250');
      await page.locator('#v-bunker-vlsfoPrice-bob').fill('620');
      await page.locator('#v-bunker-bobQuantity-lsmgo').fill('80');
      await page.locator('#v-bunker-lsmgoPrice-bob').fill('780');
      await page.locator('#v-bunker-euEtsPrice-_').fill('95');

      // The summary lives in the bottom Summary panel (no separate tab) —
      // expand it and require zero "needs attention" items for a valid sheet.
      const expand = page.getByRole('button', { name: /expand summary/i });
      if ((await expand.count()) > 0) await expand.first().click();
      await page.waitForTimeout(2000);
      await expect(page.getByText(/needs attention/).first()).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByText(/NaN/).first()).toHaveCount(0);
      await page.screenshot({ path: 'screenshots/full-summary.png', fullPage: true });

      const summaryBtn = page.locator('button[title="Sequence summary"]');
      if ((await summaryBtn.count()) > 0) {
        console.log(`final summary: ${await summaryBtn.textContent()}`);
      }
      await page.screenshot({ path: 'screenshots/full-sheet.png', fullPage: true });

      await page
        .locator('#lovable-badge')
        .evaluateAll((els) => els.forEach((el) => el.remove()))
        .catch(() => {});
      const quick = page
        .locator('button[class*="bg-white/15"]', { hasText: 'Save Sheet' })
        .first();
      const saver =
        (await quick.count()) > 0
          ? quick
          : page.getByRole('button', { name: /^save sheet$/i }).last();
      await saver.click();
      const toast = page.getByText('Sheet saved').first();
      await expect(toast).toBeVisible({ timeout: 25_000 });
      console.log(`save toast: ${(await toast.textContent())?.trim().slice(0, 120)}`);
    });

    expect(appErrors, `app errors:\n${appErrors.join('\n')}`).toEqual([]);
    await noNaN();
  });
});
