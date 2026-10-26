import { test, expect } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator } from './helpers';

/**
 * Save Sheet flow.
 * - Top toolbar: button[title="Save Sheet"] (floppy-disk icon + "Save").
 * - Bottom corner: quick "Save Sheet" button (bg-white/15).
 * The toolbar Save opens a dialog: sheet-name input (input.form-input-sm.w-32)
 * + workbook picker (select[title="Workbook"], e.g. "testing -a") + OK/Cancel
 * (Cancel is asserted, so no mutation). The footer quick button saves directly
 * with a "Sheet saved" toast. A dialog-driven real save runs only with
 * SAVE_SHEETS=1.
 */
test.describe('Save Sheet', () => {
  test.beforeEach(async ({ page }) => {
    const visible = await ensureCalculator(page);
    if (skipIfNoCalculator(visible)) test.skip(true);
  });

  async function openSaveDialog(page) {
    await page.locator('button[title="Save Sheet"]').first().click();
    const nameInput = page.locator('input.form-input-sm.w-32');
    await expect(nameInput).toBeVisible({ timeout: 20_000 });
    return nameInput;
  }

  test('top Save opens dialog with name + workbook picker (Cancel, no save)', async ({
    page,
  }) => {
    const nameInput = await openSaveDialog(page);
    await expect(nameInput).not.toHaveValue('');

    const workbook = page.locator('select[title="Workbook"]');
    await expect(workbook).toBeVisible();
    // Workbook options load async — poll until the list populates.
    await expect
      .poll(
        async () => (await workbook.locator('option').allTextContents()).join(' | '),
        { timeout: 20_000 },
      )
      .toMatch(/testing -a/);
    await page.screenshot({ path: 'screenshots/save-dialog.png' });

    await page.getByRole('button', { name: /^cancel$/i }).click();
    await expect(nameInput).toBeHidden({ timeout: 15_000 });
  });

  test('bottom quick Save Sheet saves directly with toast', async ({ page }) => {
    // Unlike the toolbar Save, the footer quick button persists immediately
    // (no dialog) and confirms with a "Sheet saved" toast.
    const quick = page
      .locator('button[class*="bg-white/15"]', { hasText: 'Save Sheet' })
      .first();
    // Fall back to the last "Save Sheet" button if the footer variant is absent.
    const target =
      (await quick.count()) > 0
        ? quick
        : page.getByRole('button', { name: /^save sheet$/i }).last();
    await expect(target).toBeVisible({ timeout: 30_000 });
    // The third-party "Edit with Lovable" badge overlays the footer corner and
    // absorbs the click, so remove it first (not app UI); then click normally.
    await page
      .locator('#lovable-badge')
      .evaluateAll((els) => els.forEach((el) => el.remove()))
      .catch(() => {});
    await target.click();

    await expect(page.getByText('Sheet saved').first()).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({ path: 'screenshots/save-quick-toast.png' });
  });

  test('real save persists (opt-in via SAVE_SHEETS=1)', async ({ page }) => {
    test.skip(
      process.env.SAVE_SHEETS !== '1',
      'Set SAVE_SHEETS=1 to actually persist a sheet to the workbook.',
    );
    const nameInput = await openSaveDialog(page);
    const name = `Playwright ${Date.now()}`;
    await nameInput.fill(name);
    await page.locator('select[title="Workbook"]').selectOption({ label: 'testing -a' });
    await page.screenshot({ path: 'screenshots/save-dialog-confirm.png' });
    await page.getByRole('button', { name: /^ok$/i }).click();
    await expect(nameInput).toBeHidden({ timeout: 30_000 });
    console.log(`Saved sheet as "${name}" into workbook "testing -a"`);
    await page.screenshot({ path: 'screenshots/save-confirmed.png' });
  });
});
