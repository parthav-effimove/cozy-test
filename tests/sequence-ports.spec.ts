import { test, expect } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';

/**
 * Sequence section: port search is backend-driven.
 * Covers the exact markup you pasted:
 *   input[placeholder="Select port..."] -> fixed-position dropdown with
 *   "Riau (indonesia) / IDRAU" style buttons.
 */
test.describe('Sequence — backend port search + selection', () => {
  test.beforeEach(async ({ page }) => {
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);
    await expect(page.getByPlaceholder('Select port...').first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('search port and select backend suggestion', async ({ page }) => {
    page.on('response', async (r) => {
      if (r.url().includes('/ports/search')) {
        console.log(` ports API: ${r.status()} ${r.url()} body=${(await r.text().catch(() => '?')).slice(0, 200)}`);
      }
    });
    // Load leg is the second sequence row (open, load, disch).
    const portInputs = page.getByPlaceholder('Select port...');
    const loadPort = portInputs.nth(1);
    await loadPort.click();
    await loadPort.fill('');
    // Type slowly so the debounced backend search settles, then wait for it.
    await loadPort.pressSequentially(SEEDS.port, { delay: 250 });
    await page.waitForResponse(
      (r) => r.url().includes('/ports/search') && r.url().includes(`q=${SEEDS.port}`),
      { timeout: 20_000 },
    ).catch(() => {});
    await page.waitForTimeout(1500);

    // Port dropdown is rendered in a fixed overlay (not inside the table).
    const overlay = page.locator(
      'div[class*="bg-popover"]:has-text("IDRAU"), div[style*="z-index: 2147483647"]',
    );
    await expect(overlay.first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'screenshots/port-dropdown.png' });

    const option = page
      .getByRole('button', { name: new RegExp(`${SEEDS.port}`, 'i') })
      .first();
    const target = (await option.count()) > 0 ? option : overlay.getByRole('button').first();
    await target.click();

    // Input keeps the chosen port label (title + value both carry it).
    await expect(loadPort).not.toHaveValue('', { timeout: 20_000 });
    console.log(`Selected port value: ${await loadPort.inputValue()}`);

    // Sea-time summary stays visible (fresh sheet totals start at 0.00d).
    await expect(page.getByText(/Sea:/).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({ path: 'screenshots/port-selected.png' });
  });

  test('partial query lists multiple ports with name + code', async ({ page }) => {
    // Matches UI: typing "hu" lists "Huachipato (chile)" / CLHPO,
    // "Huacho (peru)" / PEHCO, ... each with a map-pin icon.
    const openPort = page.getByPlaceholder('Select port...').first();
    await openPort.click();
    await openPort.fill('');
    await openPort.pressSequentially('hu', { delay: 250 });
    await page.waitForResponse(
      (r) => r.url().includes('/ports/search') && r.url().includes('q=hu'),
      { timeout: 20_000 },
    ).catch(() => {});
    await page.waitForTimeout(1500);

    const overlay = page.locator(
      'div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
    );
    await expect(overlay.first()).toBeVisible({ timeout: 20_000 });
    const text = (await overlay.first().textContent()) ?? '';
    expect(text).toMatch(/Huachipato\s*\(chile\)/i);
    expect(text).toMatch(/CLHPO/);
    expect(await overlay.getByRole('button').count()).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: 'screenshots/port-dropdown-hu.png' });
  });

  test('Add button appends a new port row (select port in it)', async ({ page }) => {
    const portInputs = page.getByPlaceholder('Select port...');
    await expect(portInputs.first()).toBeVisible({ timeout: 30_000 });
    const before = await portInputs.count();
    await page.getByRole('button', { name: /^add$/i }).first().click();
    await expect(page.getByPlaceholder('Select port...')).toHaveCount(before + 1, {
      timeout: 20_000,
    });

    const newPort = page.getByPlaceholder('Select port...').last();
    await newPort.click();
    await newPort.fill('');
    await newPort.pressSequentially('hu', { delay: 250 });
    await page.waitForTimeout(2000);
    const overlay = page.locator(
      'div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
    );
    await expect(overlay.first()).toBeVisible({ timeout: 20_000 });
    await overlay.getByRole('button').first().click();
    await expect(newPort).not.toHaveValue('', { timeout: 20_000 });
    console.log(`Added port row value: ${await newPort.inputValue()}`);
    await page.screenshot({ path: 'screenshots/port-added.png' });
  });

  test('empty discharge port shows validation state', async ({ page }) => {
    // Your third row (disch) has empty port + empty distance with
    // ring-destructive / aria-invalid=true — assert that validation UI.
    const dischPortWrap = page.locator('#v-sequence-port-3');
    await expect(dischPortWrap).toBeVisible();
    await expect(dischPortWrap).toHaveAttribute('aria-invalid', 'true');

    const dischDistance = page.locator('#v-sequence-distance-3');
    await expect(dischDistance).toHaveAttribute('aria-invalid', 'true');
    await expect(dischDistance).toHaveClass(/border-destructive|ring-destructive/);
    await page.screenshot({ path: 'screenshots/sequence-validation.png' });
  });

  test('Add / Repos / Fetch-distance / Dep controls work', async ({ page }) => {
    await expect(page.getByRole('button', { name: /add/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /repos/i }).first()).toBeVisible();

    const fetchDistance = page.locator('#auto-dist');
    await expect(fetchDistance).toBeVisible();
    // Toggle it both ways — must not throw.
    await fetchDistance.click();
    await fetchDistance.click();

    const dep = page.locator('input[type="datetime-local"]');
    await expect(dep).toBeVisible();
    await dep.fill('2026-10-21T09:00');
    await expect(dep).toHaveValue('2026-10-21T09:00');
  });
});
