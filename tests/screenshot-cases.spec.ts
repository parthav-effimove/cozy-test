import { test, expect, Page } from '@playwright/test';
import { ensureDashboard } from './helpers';

/**
 * Screenshot-verified sheet cases — Oct 15 & 19 Oct workbooks.
 *
 * Source of truth: the verified screenshots in ~/Downloads/oct 15 and
 * ~/Downloads/oct 19 (captured 2026-10-22). Each case pins a screenshot to
 * its sheet via vessel + Sea/Port/Total + economics fingerprint, opens that
 * sheet live, and asserts the computed outputs still match.
 *
 * Expected values were triple-checked: screenshot OCR vs the golden JSON
 * snapshots vs a live read of the workbook — all three agree on every
 * fingerprint below (details in tests/golden-*.json).
 *
 * Run one workbook:  npx playwright test tests/screenshot-cases.spec.ts -g "Oct 15" --project=chromium-headless
 * Run all:            npx playwright test tests/screenshot-cases.spec.ts --project=chromium-headless
 */

interface ShotCase {
  id: string;
  shot: string;          // verified screenshot file(s) in ~/Downloads/oct 15|19
  workbook: string;      // workbook to open
  tabs: string[];        // candidate sheet tabs, tried in order
  vessel: string;
  seq: string;           // exact Sequence summary button text
  econ: string[];        // economics strings that must appear on the sheet
}

const CASES_15: ShotCase[] = [
  { id: 'Oct15-01', shot: '12.48.34', workbook: '15 oct', tabs: ['12'], vessel: 'STAR LEO',
    seq: 'Sea: 36.73dPort: 20.75dTotal: 57.48d', econ: ['NTCE $ 148,944.37', 'Gross Rate $ 4.44 /mt'] },
  { id: 'Oct15-02', shot: '12.48.45 + 12.49.33', workbook: '15 oct', tabs: ['11'], vessel: 'STAR LEO',
    seq: 'Sea: 57.56dPort: 12.50dTotal: 70.06d', econ: ['Incl Hire $ 801,709.66', 'NTCE $ 38,897.97', 'Gross Rate $ 18.22 /mt'] },
  { id: 'Oct15-03', shot: '12.50.23', workbook: '15 oct', tabs: ['8'], vessel: 'HABCO ANKAA',
    seq: 'Sea: 97.74dPort: 22.50dTotal: 120.24d', econ: ['Incl Hire $ 48,435,430.52', 'NTCE $ -300,560.19', 'Gross Rate (50,000 mt) $ 863.06 /mt'] },
  { id: 'Oct15-04', shot: '12.50.30', workbook: '15 oct', tabs: ['New Sheet 7 1'], vessel: 'FUGA',
    seq: 'Sea: 16.86dPort: 60.00dTotal: 86.86d', econ: ['Incl Hire $ 762,448.66', 'NTCE $ 22,403.81', 'Gross Rate $ 25.41 /mt'] },
  { id: 'Oct15-05', shot: '12.50.48', workbook: '15 oct',
    tabs: ['8', 'New Sheet 7 1', '6', '5 1', 'New Sheet 5 2', 'New Sheet 5 1', '5', '4', '3', '2', '1 1'],
    vessel: 'SHAGANG FAITH', seq: 'Sea: 62.61dPort: 507.50dTotal: 570.11d',
    econ: ['Incl Hire $ 8,686,394.90', 'NTCE $ 71,569.17'] },
  { id: 'Oct15-06', shot: '12.51.01', workbook: '15 oct', tabs: ['5', '4'], vessel: 'FUGA',
    seq: 'Sea: 32.79dPort: 118.77dTotal: 156.57d', econ: ['Incl Hire $ 1,398,767.83'] },
  { id: 'Oct15-07', shot: '12.51.11', workbook: '15 oct', tabs: ['3'], vessel: 'FUGA',
    seq: 'Sea: 32.79dPort: 118.77dTotal: 151.57d', econ: ['Incl Hire $ 1,375,286.58'] },
  { id: 'Oct15-08', shot: '12.51.17 + 12.51.24', workbook: '15 oct', tabs: ['2', '1 1'], vessel: 'FUGA',
    seq: 'Sea: 28.35dPort: 76.00dTotal: 104.35d', econ: ['Incl Hire $ 1,132,506.26', 'NTCE $ 32,774.10'] },
];

const CASES_19: ShotCase[] = [
  { id: 'Oct19-01', shot: '12.52.42', workbook: '19 oct', tabs: ['6 1', 'sheet 6'], vessel: 'STAR LEO',
    seq: 'Sea: 74.81dPort: 23.75dTotal: 102.56d', econ: ['Incl Hire $ 1,473,895.91', 'NTCE $ 55,049.01', 'Gross Rate $ 18.66 /mt'] },
  { id: 'Oct19-02', shot: '12.52.48', workbook: '19 oct', tabs: ['sheet 7 (Copy)', 'sheet 7'], vessel: 'FUGA',
    seq: 'Sea: 8.11dPort: 9.00dTotal: 21.11d', econ: ['Incl Hire $ 152,749.65', 'NTCE $ 133,303.00', 'Gross Rate $ 5.16 /mt'] },
  { id: 'Oct19-03', shot: '12.52.55 + 12.53.03', workbook: '19 oct', tabs: ['sheet 5'], vessel: 'STAR LEO',
    seq: 'Sea: 74.81dPort: 23.75dTotal: 98.56d', econ: ['Incl Hire $ 1,463,030.91', 'NTCE $ 57,389.41'] },
  { id: 'Oct19-04', shot: '12.53.09', workbook: '19 oct', tabs: ['sheet 4'], vessel: 'STAR LEO',
    seq: 'Sea: 48.11dPort: 42.08dTotal: 93.19d', econ: ['Incl Hire $ 6,548,415.46'] },
  { id: 'Oct19-05', shot: '12.53.13', workbook: '19 oct', tabs: ['sheet 3'], vessel: 'STAR LEO',
    seq: 'Sea: 48.11dPort: 42.08dTotal: 93.19d', econ: ['Incl Hire $ 13,045,938.09', 'Gross Rate $ 188.73 /mt'] },
  { id: 'Oct19-06', shot: '12.53.19', workbook: '19 oct', tabs: ['sheet 2'], vessel: 'SEA ARROW',
    seq: 'Sea: 36.77dPort: 31.11dTotal: 70.88d', econ: ['Incl Hire $ 7,045,005.55'] },
  { id: 'Oct19-07', shot: '12.53.25', workbook: '19 oct', tabs: ['sheet 1'], vessel: 'SEA ARROW',
    seq: 'Sea: 36.77dPort: 20.00dTotal: 56.77d', econ: ['NTCE $ -40,879.34', 'Gross Rate $ 137.11 /mt'] },
];

/** Click a sheet tab by exact text and verify it became active. */
async function clickTab(page: Page, label: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ok = await page.evaluate((name) => {
      const tabs = Array.from(document.querySelectorAll('div.sheet-scroll > div'))
        .filter((el) => el.querySelector('button[aria-label^="Close"]'));
      const el = tabs.find(
        (t) => (t.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) === name,
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el.click();
      return true;
    }, label).catch(() => false);
    if (!ok) { await page.waitForTimeout(800); continue; }
    await page.waitForTimeout(2200);
    await page.keyboard.press('Escape').catch(() => {});
    const active: string = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div.sheet-scroll > div'));
      const a = tabs.find((t) =>
        t.getAttribute('aria-selected') === 'true' ||
        (t.className ?? '').toString().toLowerCase().includes('active') ||
        t.getAttribute('data-state') === 'active');
      return (a?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    }).catch(() => '');
    if (!active || active === label) return true;
  }
  return false;
}

async function readSheet(page: Page): Promise<{ vessel: string; seq: string; body: string; attention: string[] }> {
  const vessel: string = await page.evaluate(() =>
    ((document.querySelector('input[placeholder="Search vessel..."]') as HTMLInputElement)?.value ?? '').trim(),
  ).catch(() => '');
  const seq: string = await page.evaluate(() =>
    (document.querySelector('button[title="Sequence summary"]')?.textContent ?? '').trim().replace(/\s+/g, ' '),
  ).catch(() => '');
  const body: string = await page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' ')).catch(() => '');
  const attention: string[] = await page.locator('li').evaluateAll((els) =>
    els.map((li) => (li.textContent ?? '').trim().replace(/\s+/g, ' '))
      .filter((s) => /required|must equal|cannot exceed|attention/i.test(s)),
  ).catch(() => [] as string[]);
  return { vessel, seq, body, attention: attention.sort() };
}

async function runCases(page: Page, workbook: string, cases: ShotCase[]): Promise<{ pass: number; fail: string[] }> {
  const searchWB = page.getByPlaceholder('Search workbooks...');
  if ((await searchWB.count()) > 0) {
    await searchWB.fill(workbook);
    await page.waitForTimeout(2000);
  }
  const row = page.locator('tr', { hasText: workbook }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: /^open$/i }).click();
  await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });

  let pass = 0;
  const fail: string[] = [];
  for (const c of cases) {
    let matchedTab = '';
    let read = { vessel: '', seq: '', body: '', attention: [] as string[] };
    for (const tab of c.tabs) {
      if (!(await clickTab(page, tab))) continue;
      read = await readSheet(page);
      const econOk = c.econ.every((e) => read.body.includes(e));
      if (read.vessel === c.vessel && read.seq === c.seq && econOk) { matchedTab = tab; break; }
    }
    const attOk = read.attention.length === 0;
    const ok = matchedTab !== '' && attOk;
    const actual = `tab=[${matchedTab || 'NO MATCH'}] vessel=[${read.vessel}] seq=[${read.seq}] attention=${read.attention.length}`;
    if (ok) {
      pass++;
      console.log(`PASS ${c.id} wb="${c.workbook}" shot=${c.shot} ${actual}`);
    } else {
      const why = !matchedTab
        ? `no tab matched fingerprint vessel=[${c.vessel}] seq=[${c.seq}]`
        : `attention items: ${read.attention.slice(0, 2).join(' | ').slice(0, 200)}`;
      fail.push(`${c.id} (${why})`);
      console.log(`FAIL ${c.id} wb="${c.workbook}" shot=${c.shot} tabs=[${c.tabs.join('/')}] ${actual} :: ${why}`);
    }
  }
  console.log(`--- ${workbook}: ${pass} passed, ${fail.length} failed ---`);
  return { pass, fail };
}

test.describe('Oct 15 Screenshots — verified sheet outputs', () => {
  test('all Oct 15 screenshot cases match live sheets', async ({ page }) => {
    test.setTimeout(900_000);
    await ensureDashboard(page);
    const { pass, fail } = await runCases(page, '15 oct', CASES_15);
    expect(fail, `failures:\n${fail.join('\n')}`).toEqual([]);
    expect(pass).toBe(CASES_15.length);
  });
});

test.describe('19 Oct Screenshots — verified sheet outputs', () => {
  test('all 19 Oct screenshot cases match live sheets', async ({ page }) => {
    test.setTimeout(900_000);
    await ensureDashboard(page);
    const { pass, fail } = await runCases(page, '19 oct', CASES_19);
    expect(fail, `failures:\n${fail.join('\n')}`).toEqual([]);
    expect(pass).toBe(CASES_19.length);
  });
});
