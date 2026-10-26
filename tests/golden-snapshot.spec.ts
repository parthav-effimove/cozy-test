import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ensureDashboard } from './helpers';

/**
 * GOLDEN SNAPSHOT (read-only, on demand: GOLDEN_SNAPSHOT=1).
 * Opens the three verified workbooks — "oct 20" (10 sheets), "19 oct",
 * "15 oct" — and records EVERY sheet's exact inputs + expected outputs into
 * goldens/<workbook>.json WITHOUT altering any value (pure reads).
 *
 * Run all:    GOLDEN_SNAPSHOT=1 npx playwright test tests/golden-snapshot.spec.ts --project=chromium-headless --workers=1
 * Run one:    GOLDEN_SNAPSHOT=1 npx playwright test tests/golden-snapshot.spec.ts -g "snapshot oct 20" --project=chromium-headless --workers=1
 *
 * Single-pass capture: each sheet tab is visited EXACTLY ONCE by index
 * (previous two-pass + content-key dedupe over-counted 19 oct as 14).
 * Outputs captured: sequence summary, needs-attention list, computed money
 * fields (NTC/NetBB/GrossBB/quantity-balance) + voyage panel text when open.
 */
const TARGETS = [
  { needle: 'oct 20', file: 'golden-oct20.json' },
  { needle: '19 oct', file: 'golden-19oct.json' },
  { needle: '15 oct', file: 'golden-15oct.json' },
];

test.describe('Golden snapshot — read verified sheets', () => {
  for (const t of TARGETS) {
    test(`snapshot ${t.needle}`, async ({ page }) => {
      test.skip(process.env.GOLDEN_SNAPSHOT !== '1', 'Run with GOLDEN_SNAPSHOT=1');
      test.setTimeout(1_800_000);
      await ensureDashboard(page);

      const appErrors: string[] = [];
      page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

      // The list shows only the 10 most recent workbooks — search for the
      // target explicitly (test workbooks would otherwise push it off-page).
      const searchWB = page.getByPlaceholder('Search workbooks...');
      if ((await searchWB.count()) > 0) {
        await searchWB.fill(t.needle);
        await page.waitForTimeout(2000);
      }
      let row = page.locator('tr', { hasText: t.needle }).first();
      for (let attempt = 0; attempt < 3 && (await row.count()) === 0; attempt++) {
        console.log(`workbook list missing "${t.needle}", reload retry ${attempt + 1}/3`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2000);
        const estimator = page.locator('button[title="Voyage Estimator"]');
        if ((await estimator.count()) > 0) await estimator.first().click().catch(() => {});
        await page.waitForTimeout(2000);
        if ((await searchWB.count()) > 0) {
          await searchWB.fill(t.needle);
          await page.waitForTimeout(2000);
        }
        row = page.locator('tr', { hasText: t.needle }).first();
      }
      await expect(row).toBeVisible({ timeout: 30_000 });
      console.log(`OPEN ${(await row.textContent())?.trim().replace(/\s+/g, ' ').slice(0, 100)}`);
      await row.getByRole('button', { name: /^open$/i }).click();
      await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });

      const tagStrip = () =>
        page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll('div.sheet-scroll > div:has(> button[aria-label^="Close"])'),
          );
          items.forEach((el, i) => el.setAttribute('data-golden-idx', String(i)));
          return items.map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60));
        });

      // Click each tab by its TEXT (not index): the strip re-renders on
      // every switch and the active tab drops its Close button, so indexed
      // locators go stale and tail tabs get skipped. Text match survives.
      const names: string[] = await tagStrip();
      console.log(`strip items (${names.length}): ${names.join(' | ').slice(0, 500)}`);
      const sheets: Record<string, unknown>[] = [];
      const count: number = names.length;
      const clickTab = (name: string): Promise<boolean> =>
        page.evaluate((label) => {
          const tabs = Array.from(
            document.querySelectorAll('div.sheet-scroll > div'),
          ).filter((el) => el.querySelector('button[aria-label^="Close"]'));
          const el = tabs.find(
            (t) => (t.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) === label,
          ) as HTMLElement | undefined;
          if (!el) return false;
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          el.click();
          return true;
        }, name).catch(() => false);
      for (let i = 0; i < count; i++) {
        let ok = false;
        for (let attempt = 0; attempt < 4 && !ok; attempt++) {
          ok = await clickTab(names[i]);
          if (!ok) await page.waitForTimeout(800);
        }
        if (!ok) {
          console.log(`sheet idx ${i} (${names[i] ?? '?'}): tab not clickable, skipping`);
          continue;
        }
        await page.waitForTimeout(2000);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        // Verify the ACTIVE tab is the one we clicked (strip re-renders;
        // a stale click would silently record the wrong sheet's values).
        const activeName: string = await page.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('div.sheet-scroll > div'));
          const active = tabs.find((t) =>
            t.getAttribute('aria-selected') === 'true' ||
            (t.className ?? '').toString().toLowerCase().includes('active') ||
            t.getAttribute('data-state') === 'active' ||
            t.getAttribute('aria-current') === 'true',
          );
          return ((active?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60));
        }).catch(() => '');
        if (activeName && activeName !== names[i]) {
          console.log(`sheet idx ${i} (${names[i]}): active tab is "${activeName}", re-clicking`);
          await clickTab(names[i]);
          await page.waitForTimeout(2000);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(500);
        }
        // Wait for sheet content to settle (two stable seqBtn reads).
        let stable = '';
        for (let s = 0; s < 4; s++) {
          const cur: string = await page.evaluate(() =>
            (document.querySelector('button[title="Sequence summary"]')?.textContent ?? '').trim().replace(/\s+/g, ' '),
          ).catch(() => '');
          if (cur && cur === stable) break;
          stable = cur;
          await page.waitForTimeout(1000);
        }
        const dump = await page.evaluate(() => {
          const inputs: Record<string, string> = {};
          document.querySelectorAll('input[id^="v-"]').forEach((n) => {
            const e = n as HTMLInputElement;
            inputs[e.id] = e.value;
          });
          const selects: Record<string, string> = {};
          document.querySelectorAll('select').forEach((n, k) => {
            const e = n as HTMLSelectElement;
            selects[e.id || `select-${k}`] = e.value;
          });            const vessel =
              (document.querySelector('input[placeholder="Search vessel..."]') as HTMLInputElement)?.value ?? '';
            const ports = Array.from(document.querySelectorAll('input[placeholder="Select port..."]')).map(
              (n) => (n as HTMLInputElement).value,
            );
            // Per-leg load/disch/bkrg/pssg type triggers, in leg order —
            // replay must set these before filling quantities.
            const legTypes: string[] = Array.from(document.querySelectorAll('button.form-select-sm'))
              .map((b) => ((b.textContent ?? '').trim().toLowerCase()))
              .filter((t) => /^(load|disch|bkrg|pssg)$/.test(t));
          const seqBtn =
            (document.querySelector('button[title="Sequence summary"]')?.textContent ?? '').trim().replace(/\s+/g, ' ');
          const attention = Array.from(document.querySelectorAll('li')).map((li) =>
            (li.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 250),
          ).filter((s) => /required|must equal|cannot exceed|attention/i.test(s));
          const panel = (((document.querySelector('body')?.textContent ?? '').replace(/\s+/g, ' ')).slice(0, 6000));
          return { inputs, selects, vessel, ports, legTypes, seqBtn, attention, panel };
        });
        // Tab label from the initial strip listing — re-reading el after the
        // click returns '' (switching sheets re-renders the strip).
        const tabName = (names[i] ?? '').slice(0, 60);
        sheets.push({ tab: tabName, index: i, ...dump });
        console.log(`sheet#${sheets.length} idx=${i} [${tabName.slice(0, 30)}]: vessel=${String(dump.vessel).slice(0, 30)} ports=${(dump.ports as string[]).filter(Boolean).length} legs=[${(dump.legTypes as string[]).join(',')}] qty2=${dump.inputs['v-sequence-quantity-2']} rate=${dump.inputs['v-cargo-rate-1']} seq=[${dump.seqBtn.slice(0, 80)}] attention=${dump.attention.length}`);
      }

      await writeFile(`goldens/${t.file}`, JSON.stringify({ workbook: t.needle, capturedAt: new Date().toISOString(), sheets }, null, 1));
      console.log(`wrote ${t.file}: ${sheets.length} sheets (visited each tab once)`);
      expect(sheets.length, 'at least one sheet snapshotted').toBeGreaterThan(0);
      expect(appErrors, `pageerrors:\n${appErrors.join('\n')}`).toEqual([]);
    });
  }
});
