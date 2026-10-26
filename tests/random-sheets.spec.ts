import { test, expect, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ensureCalculator, skipIfNoCalculator } from './helpers';

/**
 * RANDOM SHEETS — builds N complete sheets with randomized (seeded) data and
 * saves each one via the toolbar Save dialog into workbook "testing -a".
 * Seed: RANDOM_SEED env or Date.now() (logged + stored in
 * test-results/random-sheets.json so any run is reproducible).
 * Count: RANDOM_SHEETS env (default 3).
 * Fails on page errors, NaN, or a failed save. Soft-logs summary attention
 * items without failing (random data can legitimately flag e.g. drafts).
 */

const VESSEL_QUERIES = ['FUGA', 'OCEAN', 'NORDIC', 'ATLANTIC', 'BALTIC', 'CORAL'];
const PORT_QUERIES = [
  'Singapore', 'Tubarao', 'Qingdao', 'Santos', 'Durban', 'Riau',
  'Paradip', 'Colombo', 'Rotterdam', 'Fujairah', 'Mumbai', 'Tokyo',
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test.describe('Random sheets — build every input + save', () => {
  test('create and save randomized sheets', async ({ page }) => {
    test.setTimeout(900_000);
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);

    const seed = Number(process.env.RANDOM_SEED ?? Date.now() % 100000);
    const count = Number(process.env.RANDOM_SHEETS ?? 3);
    const rnd = mulberry32(seed);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
    const num = (min: number, max: number, dec = 0) =>
      Number((min + rnd() * (max - min)).toFixed(dec));
    console.log(`RANDOM seed=${seed} sheets=${count}`);
    const saved: Record<string, unknown>[] = [];

    const appErrors: string[] = [];
    page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const t = m.text().slice(0, 200);
        if (!/favicon|net::/i.test(t)) appErrors.push(`console: ${t}`);
      }
    });

    const searchAndPickFirst = async (
      input: ReturnType<Page['getByPlaceholder']>,
      queries: string[],
      api: string,
      label: string,
    ): Promise<string> => {
      for (const q of queries) {
        await input.click();
        await input.fill('');
        await input.pressSequentially(q, { delay: 250 });
        await page
          .waitForResponse((r) => r.url().includes(api) && r.url().includes(`q=${q}`), {
            timeout: 20_000,
          })
          .catch(() => {});
        await page.waitForTimeout(1500);
        if ((await page.getByText('No vessels found').count()) > 0) continue;
        const overlay = page.locator(
          'div.absolute.z-50:has(button), div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
        );
        if ((await overlay.first().count()) === 0) continue;
        await expect(overlay.first()).toBeVisible({ timeout: 15_000 }).catch(() => {});
        const btn = overlay.getByRole('button').first();
        if ((await btn.count()) === 0) continue;
        await btn.click();
        await expect(input).not.toHaveValue('', { timeout: 20_000 }).catch(() => {});
        const val = await input.inputValue().catch(() => '');
        if (val) {
          console.log(`${label} <= ${q} → ${val.slice(0, 60)}`);
          return val;
        }
      }
      throw new Error(`${label}: no backend suggestion for any query`);
    };
    const shuffled = <T,>(arr: T[]): T[] =>
      [...arr].sort(() => rnd() - 0.5);

    for (let i = 0; i < count; i++) {
      const sheetName = `Random ${seed}-${i + 1}`;
      const record: Record<string, unknown> = { sheet: sheetName };
      console.log(`--- sheet ${i + 1}/${count}: ${sheetName}`);

      await test.step(`sheet ${i + 1}: new sheet + vessel`, async () => {
        if (i > 0) {
          await page.getByRole('button', { name: /^new sheet$/i }).first().click();
          await page.waitForTimeout(2000);
        }
        const search = page.getByPlaceholder('Search vessel...');
        await expect(search.first()).toBeVisible({ timeout: 30_000 });
        // Newest sheet tab is last; its search box is the last one on the page
        // when multiple sheets render — scope to the visible calculator instead.
        const vessel = search.first();
        record.vessel = await searchAndPickFirst(vessel, shuffled(VESSEL_QUERIES), '/vessels', 'vessel');
        const dwt = page.locator('#v-vessel-dwt-_').first();
        await expect.poll(async () => dwt.inputValue(), { timeout: 30_000 }).not.toBe('');
        const dwtNum = Number((await dwt.inputValue()).replace(/[^0-9.]/g, '')) || 38036;
        record.dwt = dwtNum;
        // Validation: total loading quantity cannot exceed vessel DWT — cap
        // the load quantity with margin so the sheet stays valid.
        record.safeQty = String(Math.max(5000, Math.min(31400, Math.floor(dwtNum - 2000))));

        const fill = async (id: string, v: string) => {
          const el = page.locator(id).first();
          if ((await el.count()) > 0 && (await el.isEnabled().catch(() => false))) {
            await el.fill(v).catch(() => {});
          }
        };
        await fill('#v-vessel-matrix_speed_ballast-_', String(num(10, 13, 1)));
        await fill('#v-vessel-matrix_speed_laden-_', String(num(10, 13, 1)));
        for (const f of ['vlsfo', 'lsmgo', 'ae']) {
          for (const m of ['ballast', 'laden', 'load', 'discharge', 'idle']) {
            await fill(`#v-vessel-matrix_${f}_${m}-_`, String(num(1, 28, 2)));
          }
        }
        record.speeds = {
          ballast: await page.locator('#v-vessel-matrix_speed_ballast-_').first().inputValue().catch(() => ''),
          laden: await page.locator('#v-vessel-matrix_speed_laden-_').first().inputValue().catch(() => ''),
        };
      });

      await test.step(`sheet ${i + 1}: sequence ports + legs`, async () => {
        const queries = shuffled(PORT_QUERIES);
        let qi = 0;
        const nextPort = async (idx: number) => {
          const input = page.getByPlaceholder('Select port...').nth(idx);
          const val = await searchAndPickFirst(input, queries.slice(qi).concat(queries.slice(0, qi)), '/ports/search', `port[${idx}]`);
          qi = (qi + 1) % queries.length;
          return val;
        };
        record.ports = [await nextPort(0), await nextPort(1), await nextPort(2)];

        // Random extra legs: 0–2 via Add, 50% Repos row.
        const extraDisch = Math.floor(rnd() * 3);
        for (let k = 0; k < extraDisch; k++) {
          const n = await page.getByPlaceholder('Select port...').count();
          await page.getByRole('button', { name: /^add$/i }).first().click();
          await expect(page.getByPlaceholder('Select port...')).toHaveCount(n + 1, { timeout: 20_000 });
          (record.ports as string[]).push(await nextPort(n));
        }
        if (rnd() < 0.5) {
          const n = await page.getByPlaceholder('Select port...').count();
          await page.getByRole('button', { name: /^repos$/i }).first().click();
          await expect(page.getByPlaceholder('Select port...')).toHaveCount(n + 1, { timeout: 20_000 });
          (record.ports as string[]).push(await nextPort(n));
          record.repos = true;
        }

        // Cap by vessel DWT (see vessel step): total load must be < DWT.
        const loadQty = (record.safeQty as string) ?? String(num(20000, 30000, 0));
        const set = async (id: string, v: string) => {
          const el = page.locator(id).first();
          if ((await el.count()) > 0 && (await el.isEnabled().catch(() => false))) {
            await el.fill(v).catch(() => {});
          }
        };
        await set('#v-sequence-quantity-2', loadQty);
        await set('#v-sequence-productivity-2', String(num(8000, 20000, 0)));
        // Cargo balance: sum of discharge legs must equal the load leg.
        // Split loadQty evenly across the disch legs that exist (3..6).
        const total = Number(loadQty);
        const dischLegs: number[] = [];
        for (const leg of [3, 4, 5, 6]) {
          if ((await page.locator(`#v-sequence-quantity-${leg}`).count()) > 0) dischLegs.push(leg);
        }
        let assigned = 0;
        for (let d = 0; d < dischLegs.length; d++) {
          const leg = dischLegs[d];
          const share = d === dischLegs.length - 1 ? total - assigned : Math.floor(total / dischLegs.length);
          assigned += share;
          await set(`#v-sequence-quantity-${leg}`, String(share));
          await set(`#v-sequence-productivity-${leg}`, String(num(8000, 15000, 0)));
          await set(`#v-sequence-turnTime-${leg}`, String(num(6, 24, 0)));
          await set(`#v-sequence-expDa-${leg}`, String(num(20000, 80000, 0)));
        }
        record.quantity = loadQty;
        record.dischSplit = dischLegs.length;

        const fetch = page.locator('#auto-dist');
        if ((await fetch.count()) > 0 && !(await fetch.isChecked().catch(() => true))) {
          await fetch.click().catch(() => {});
        }
        await page.waitForTimeout(4000);
        for (const leg of [2, 3, 4]) {
          const d = page.locator(`#v-sequence-distance-${leg}`);
          if ((await d.count()) > 0 && (await d.inputValue()) === '') {
            await d.fill(String(num(1000, 11000, 0))).catch(() => {});
          }
        }
      });

      await test.step(`sheet ${i + 1}: cargo + intake + misc/bunker`, async () => {
        if (rnd() < 0.7) {
          await page.getByRole('button', { name: /add cargo/i }).click();
          await page.waitForTimeout(1500);
        }
        const set = async (id: string, v: string) => {
          const el = page.locator(id).first();
          if ((await el.count()) > 0 && (await el.isEnabled().catch(() => false))) {
            await el.fill(v).catch(() => {});
          }
        };
        await set('#v-cargo-rate-1', String(num(15, 60, 1)));
        await set('#v-cargo-voyageCommission-1', String(num(1, 3.75, 2)));
        await set('#v-cargo-demurrageRate-1', String(num(12000, 25000, 0)));
        await set('#v-cargo-despatchRate-1', String(num(6000, 12500, 0)));
        await set('#v-cargo-gtc-_header', String(num(12000, 22000, 0)));
        // Every extra cargo row requires its own Rate (else "needs attention").
        // Mirror row-1 values onto row-2 when it exists so balance holds.
        for (const row of [2, 3]) {
          if ((await page.locator(`#v-cargo-rate-${row}`).count()) > 0) {
            await set(`#v-cargo-rate-${row}`, String(num(15, 60, 1)));
            await set(`#v-cargo-voyageCommission-${row}`, String(num(1, 3.75, 2)));
            await set(`#v-cargo-demurrageRate-${row}`, String(num(12000, 25000, 0)));
            await set(`#v-cargo-despatchRate-${row}`, String(num(6000, 12500, 0)));
          }
        }

        await page.getByRole('button', { name: /intake calculator/i }).first().click();
        const idwt = page.locator('#v-intake-dwt-_');
        await expect(idwt).toBeVisible({ timeout: 20_000 }).catch(() => {});
        if ((await idwt.count()) > 0) {
          if ((await idwt.inputValue()) === '') await idwt.fill('38036').catch(() => {});
          await set('#v-intake-constants-_', String(num(200, 600, 0)));
          await set('#v-intake-bunkers-_', String(num(500, 1500, 0)));
          await set('#v-intake-freshWater-_', String(num(80, 250, 0)));
          const upd = page.getByRole('button', { name: /update intake/i });
          if ((await upd.count()) > 0) await upd.first().click();
          await page.waitForTimeout(1500);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        }

        await set('#v-misc-miscCost-_', String(num(1000, 15000, 0)));
        await set('#v-misc-extraFees-_', String(num(500, 5000, 0)));
        await set('#v-misc-extraInsurance-_', String(num(500, 3000, 0)));
        await set('#v-misc-canalCost1-_', String(num(100000, 400000, 0)));
        await set('#v-bunker-bobQuantity-vlsfo', String(num(100, 400, 0)));
        await set('#v-bunker-vlsfoPrice-bob', String(num(500, 700, 0)));
        await set('#v-bunker-bobQuantity-lsmgo', String(num(30, 150, 0)));
        await set('#v-bunker-lsmgoPrice-bob', String(num(650, 900, 0)));
        await set('#v-bunker-euEtsPrice-_', String(num(70, 120, 0)));
      });

      await test.step(`sheet ${i + 1}: save via dialog`, async () => {
        // Require a clean Voyage Summary: expand it and fail on any
        // "needs attention" item (Rate required / quantity balance / DWT cap).
        const expand = page.getByRole('button', { name: /expand summary/i });
        if ((await expand.count()) > 0) await expand.first().click();
        await page.waitForTimeout(2000);
        const attention = page.getByText(/needs attention/i).first();
        if ((await attention.count()) > 0) {
          const items = await page.locator('li:has-text("must equal"), li:has-text("required"), li:has-text("cannot exceed")').allTextContents().catch(() => []);
          console.log(`attention items: ${items.join(' || ').slice(0, 500)}`);
        }
        await expect(page.getByText(/needs attention/i).first()).toHaveCount(0, { timeout: 20_000 });
        record.cleanSummary = true;
        await page.screenshot({ path: `screenshots/random-${seed}-${i + 1}.png`, fullPage: false });
        await page.locator('button[title="Save Sheet"]').first().click();
        const nameInput = page.locator('input.form-input-sm.w-32');
        await expect(nameInput).toBeVisible({ timeout: 20_000 });
        await nameInput.fill(sheetName);
        const workbook = page.locator('select[title="Workbook"]');
        await expect
          .poll(async () => (await workbook.locator('option').allTextContents()).join(' | '), {
            timeout: 20_000,
          })
          .toMatch(/testing -a/);
        await workbook.selectOption({ label: 'testing -a' });
        await page.getByRole('button', { name: /^ok$/i }).click();
        const toast = page.getByText('Sheet saved').first();
        await expect(toast).toBeVisible({ timeout: 25_000 });
        record.savedToast = (await toast.textContent())?.trim().slice(0, 120);
        expect(await page.getByText('NaN').count(), 'NaN on page').toBe(0);
        saved.push(record);
        console.log(`saved ${sheetName}: ${JSON.stringify(record).slice(0, 300)}`);
      });
    }

    await writeFile('test-results/random-sheets.json', JSON.stringify({ seed, count, saved }, null, 1));
    expect(appErrors, `app errors:\n${appErrors.join('\n')}`).toEqual([]);
  });
});
