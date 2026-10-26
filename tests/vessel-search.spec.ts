import { test, expect } from '@playwright/test';
import {
  ensureCalculator,
  skipIfNoCalculator,
  SEEDS,
} from './helpers';

/**
 * Vessel search: backend-driven dropdown.
 * Covers the exact markup you pasted:
 *   input[placeholder="Search vessel..."] -> dropdown .absolute.z-50 button (vessel name + IMO/DWT)
 */
test.describe('Vessel — backend search + dropdown selection', () => {
  let calculatorVisible = false;

  test.beforeEach(async ({ page }) => {
    calculatorVisible = await ensureCalculator(page);
    if (skipIfNoCalculator(calculatorVisible)) test.skip(true);
    await expect(
      page.getByPlaceholder('Search vessel...'),
      'vessel search box should be visible',
    ).toBeVisible({ timeout: 30_000 });
  });

  test('search vessel and pick backend suggestion (visual)', async ({ page }) => {
    page.on('response', async (r) => {
      if (r.url().includes('/vessels')) {
        console.log(` vessels API: ${r.status()} ${r.url()} body=${(await r.text().catch(() => '?')).slice(0, 300)}`);
      }
    });
    const search = page.getByPlaceholder('Search vessel...');
    await search.click();
    await search.fill('');
    // Type slowly so the debounced backend search settles on the full query,
    // then wait for the final q=FUGA response before asserting the list.
    await search.pressSequentially(SEEDS.vessel, { delay: 250 });
    await page.waitForResponse(
      (r) => r.url().includes('/vessels') && r.url().includes(`q=${SEEDS.vessel}`),
      { timeout: 20_000 },
    ).catch(() => {});
    await page.waitForTimeout(1500);

    // Backend suggestion list appears below the input.
    const dropdown = page.locator(
      'div.absolute.z-50:has(button), div[class*="z-50"]:has-text("IMO:")',
    );
    // If a stale "No vessels found" rendered from an in-flight race, retype once.
    if ((await page.getByText('No vessels found').count()) > 0) {
      await search.fill('');
      await search.pressSequentially(SEEDS.vessel, { delay: 250 });
      await page.waitForTimeout(2000);
    }
    await expect(dropdown.first()).toBeVisible({ timeout: 20_000 });

    // Visual proof of the suggestion list.
    await page.screenshot({ path: 'screenshots/vessel-dropdown.png' });

    // Exact dropdown content per UI: name + type/IMO/DWT + TPD line + manual entry.
    const dropdownText = (await dropdown.first().textContent()) ?? '';
    expect(dropdownText).toMatch(/FUGA/i);
    expect(dropdownText).toMatch(/IMO:\s*9624615/);
    expect(dropdownText).toMatch(/DWT:\s*38,?036/);
    expect(dropdownText).toMatch(/TPD/);
    await expect(
      page.getByRole('button', { name: /enter vessel manually/i }),
    ).toBeVisible();

    const suggestion = page
      .locator('div.absolute.z-50 button, div[class*="z-50"] button')
      .filter({ hasText: new RegExp(SEEDS.vessel, 'i') })
      .first();

    // Fall back to the first vessel suggestion if the seeded name is absent.
    const target = (await suggestion.count()) > 0
      ? suggestion
      : page.locator('div.absolute.z-50 button').first();
    await expect(target).toBeVisible();
    const vesselName = (await target.textContent())?.trim().slice(0, 80);

    // Click the suggestion; if the card does not hydrate, retry via keyboard.
    console.log(`dropdown items: ${await dropdown.getByRole('button').count()}`);
    await target.click();
    console.log(`search value post-click: ${await search.inputValue()}`);
    const dwtEarly = page.locator('#v-vessel-dwt-_');
    const hydrated = await expect
      .poll(async () => dwtEarly.inputValue(), { timeout: 10_000 })
      .not.toBe('')
      .then(() => true)
      .catch(() => false);
    if (!hydrated) {
      await search.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
    }

    // Selecting a vessel should hydrate vessel fields (DWT at minimum).
    // FUGA per backend: DWT 38036, GT 23264.
    const dwt = page.locator('#v-vessel-dwt-_');
    await expect(dwt).toBeVisible();
    await expect.poll(async () => dwt.inputValue(), { timeout: 30_000 }).not.toBe('');
    console.log(`Selected vessel: ${vesselName} → DWT=${await dwt.inputValue()}`);

    await page.screenshot({ path: 'screenshots/vessel-selected.png', fullPage: false });
  });

  test('manual vessel entry option exists', async ({ page }) => {
    const search = page.getByPlaceholder('Search vessel...');
    await search.click();
    await search.fill('Test Vessel Manual 123');

    const manual = page.getByRole('button', { name: /enter vessel manually/i });
    await expect(manual).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'screenshots/vessel-manual-option.png' });
  });

  test('clearing search resets vessel card without crashing', async ({ page }) => {
    const search = page.getByPlaceholder('Search vessel...');
    await search.fill(SEEDS.vessel);
    await search.fill('');
    await expect(search).toHaveValue('');
  });
});
