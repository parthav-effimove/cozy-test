import { test, expect } from '@playwright/test';
import { ensureDashboard, SEEDS } from './helpers';

/**
 * PREFLIGHT — the cheap checks that otherwise surface minutes into a replay.
 *
 *   app reachable      the app under test answers at all
 *   workbook list      the login gate is passed and the workbook list renders
 *   port suggestions   the backend returns a port for a search (this is what silently
 *                      fails in headless mode: no suggestion, six retries, sheet 1 dies)
 *   voyage summary     the calculator, not just the dashboard, is on screen
 *
 * Each step prints `PREFLIGHT ok|fail <step>: <detail>`, which `dashboard/server.mjs`
 * turns into a checklist. Exit code is non-zero when any step failed.
 */
test('preflight', async ({ page }) => {
  test.setTimeout(240_000);
  const failed: string[] = [];

  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      console.log(`PREFLIGHT ok ${name}: ${detail}`);
      return true;
    } catch (err) {
      const message = (err as Error).message.split('\n')[0].slice(0, 200);
      console.log(`PREFLIGHT fail ${name}: ${message}`);
      failed.push(`${name}: ${message}`);
      return false;
    }
  };

  const reachable = await step('app reachable', async () => {
    const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
    const status = res?.status() ?? 0;
    if (status >= 400) throw new Error(`HTTP ${status}`);
    return `HTTP ${status}`;
  });
  if (!reachable) {
    expect(failed, failed.join('\n')).toEqual([]);
    return;
  }

  const listed = await step('workbook list', async () => {
    const ok = await ensureDashboard(page);
    if (!ok) throw new Error('login failed — set VOYAGE_EMAIL and VOYAGE_PASSWORD in .env');
    return 'new workbook button visible';
  });
  if (!listed) {
    expect(failed, failed.join('\n')).toEqual([]);
    return;
  }

  await step('port suggestions', async () => {
    // A port search only exists inside a sheet, so borrow the newest workbook.
    const open = page.getByRole('button', { name: /^open$/i }).first();
    if ((await open.count()) === 0) throw new Error('no workbook to open — create one first');
    await open.click();
    const field = page.getByPlaceholder('Select port...').first();
    await field.waitFor({ state: 'visible', timeout: 60_000 });
    await field.click();
    await field.fill('');
    await field.fill(SEEDS.port);
    const overlay = page.locator('div.absolute.z-50:has(button), div[style*="z-index: 2147483647"], div[class*="bg-popover"]');
    const rows = overlay.locator('button[role="option"], button, [role="option"]');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    const count = await rows.count();
    await page.keyboard.press('Escape').catch(() => {});
    if (count === 0) {
      throw new Error(
        `no suggestion for "${SEEDS.port}" — the app only answers port searches for a visible browser, so keep "Watch browser" on`,
      );
    }
    return `${count} suggestion(s) for "${SEEDS.port}"`;
  });

  await step('voyage summary', async () => {
    // The card title is a plain heading while the voyage still has invalid fields and a button once
    // it is valid, so match the text rather than a role.
    const summary = page.getByText('Voyage Summary', { exact: true }).first();
    await summary.waitFor({ state: 'visible', timeout: 30_000 });
    return 'Voyage Summary present';
  });

  expect(failed, failed.join('\n')).toEqual([]);
});
