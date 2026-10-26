import { Page, expect } from '@playwright/test';

/** Base URL of the app under test. */
export const BASE_URL =
  process.env.BASE_URL ?? 'https://cozy-crafting-cloud.lovable.app';

export const CREDENTIALS = {
  email: process.env.VOYAGE_EMAIL ?? '',
  password: process.env.VOYAGE_PASSWORD ?? '',
};

export const SEEDS = {
  vessel: process.env.VESSEL_QUERY || 'FUGA',
  port: process.env.PORT_QUERY || 'Riau',
};

/** True when the login gate ("Welcome back") is shown instead of the calculator. */
export async function isLoginGate(page: Page): Promise<boolean> {
  return (await page.getByRole('heading', { name: /welcome back/i }).count()) > 0;
}

/**
 * Full navigation: login → dismiss MFA → Voyage Estimator →
 * workbook "testing -a" → Open → calculator sheet.
 * Returns true when the calculator is reachable.
 */
export async function ensureCalculator(page: Page): Promise<boolean> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  if (await isLoginGate(page)) {
    if (!CREDENTIALS.email || !CREDENTIALS.password) return false;
    await page.getByPlaceholder(/enter your email/i).fill(CREDENTIALS.email);
    await page.getByPlaceholder(/enter your password/i).fill(CREDENTIALS.password);
    await page.getByRole('button', { name: /^login$/i }).click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    // Dismiss MFA upsell if shown (may appear a few seconds after login).
    const mfa = page.getByRole('dialog', { name: /secure your account/i });
    if ((await mfa.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false))) {
      await page.getByRole('button', { name: /remind me later/i }).click();
      await mfa.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    }
  }

  // Already on a calculator sheet?
  if ((await page.getByPlaceholder('Search vessel...').count()) > 0) return true;

  // Dashboard loads first (can be slow) — the sidebar button renders with
  // it, so wait for that directly rather than a specific heading.
  const estimator = page.locator('button[title="Voyage Estimator"]');
  await expect(estimator).toBeVisible({ timeout: 60_000 });
  await estimator.click();
  await expect(
    page.getByRole('button', { name: /new workbook/i }),
  ).toBeVisible({ timeout: 30_000 });

  // Open workbook "testing -a" (first row with that name). The workbook
  // list API flakes occasionally (empty list under load), so retry with a
  // reload instead of failing on the first empty render.
  let row = page.locator('tr', { hasText: 'testing -a' }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(2000);
    if ((await row.count()) > 0) break;
    // List rendered but without our row (or not at all) — reload and retry.
    if ((await page.locator('tbody tr').count()) >= 0) {
      console.log(`workbook list missing testing -a, reload retry ${attempt + 1}/3`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2000);
      const estimator = page.locator('button[title="Voyage Estimator"]');
      if ((await estimator.count()) > 0) await estimator.first().click().catch(() => {});
      row = page.locator('tr', { hasText: 'testing -a' }).first();
    }
  }
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.getByRole('button', { name: /^open$/i }).click();

  await expect(page.getByPlaceholder('Search vessel...')).toBeVisible({ timeout: 30_000 });
  return true;
}

/**
 * Login + land on the dashboard (workbook list) without opening any workbook.
 * Returns true when the "New Workbook" button is visible.
 */
export async function ensureDashboard(page: Page): Promise<boolean> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  if (await isLoginGate(page)) {
    if (!CREDENTIALS.email || !CREDENTIALS.password) return false;
    await page.getByPlaceholder(/enter your email/i).fill(CREDENTIALS.email);
    await page.getByPlaceholder(/enter your password/i).fill(CREDENTIALS.password);
    await page.getByRole('button', { name: /^login$/i }).click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    const mfa = page.getByRole('dialog', { name: /secure your account/i });
    if ((await mfa.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false))) {
      await page.getByRole('button', { name: /remind me later/i }).click();
      await mfa.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    }
  }

  // The workbook list lives inside the Voyage Estimator view (same as
  // ensureCalculator): click the sidebar entry, then the list renders.
  const estimator = page.locator('button[title="Voyage Estimator"]');
  if ((await estimator.count()) > 0) {
    await estimator.first().click();
    await page.waitForTimeout(1500);
  }
  const nw = page.getByRole('button', { name: /new workbook/i });
  await expect(nw.first()).toBeVisible({ timeout: 60_000 });
  return true;
}

/** Skip helper with a clear message when auth is required but missing. */
export function skipIfNoCalculator(calculatorVisible: boolean) {
  if (!calculatorVisible) {
    console.log(
      'SKIP: calculator is behind login. Set VOYAGE_EMAIL + VOYAGE_PASSWORD in .env to run authenticated steps.',
    );
  }
  return !calculatorVisible;
}

export async function takeSectionScreenshot(
  page: Page,
  selector: string,
  path: string,
) {
  const el = page.locator(selector).first();
  if ((await el.count()) > 0) {
    await el.screenshot({ path });
  } else {
    await page.screenshot({ path });
  }
}
