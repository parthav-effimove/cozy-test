import { test, expect } from '@playwright/test';
import { BASE_URL, CREDENTIALS, isLoginGate } from './helpers';

/**
 * Runs WITHOUT credentials: documents the login gate at /.
 * This is the test that passes today (the app currently shows
 * "Welcome back / Sign in" before the calculator).
 */
test.describe('Auth gate (no credentials needed)', () => {
  test('login page renders with email + password + Login', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    expect(page.url()).toContain(new URL(BASE_URL).hostname.replace('https://', ''));

    if (await isLoginGate(page)) {
      await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
      await expect(page.getByPlaceholder(/enter your email/i)).toBeVisible();
      await expect(page.getByPlaceholder(/enter your password/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /^login$/i })).toBeVisible();
      await expect(page.getByText(/multi-factor/i)).toBeVisible();
      await page.screenshot({ path: 'screenshots/auth-gate.png' });

      // Empty submit must not navigate anywhere.
      await page.getByRole('button', { name: /^login$/i }).click();
      await page.waitForTimeout(1000);
      expect(await isLoginGate(page)).toBe(true);
    } else {
      // Already authenticated (persisted session) — calculator is up.
      await expect(page.getByPlaceholder(/search vessel|select port/i).first()).toBeVisible({
        timeout: 30_000,
      });
    }
    console.log(`credentials present: ${Boolean(CREDENTIALS.email && CREDENTIALS.password)}`);
  });
});
