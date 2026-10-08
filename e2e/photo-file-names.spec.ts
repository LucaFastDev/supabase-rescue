import { expect, test, type Page } from '@playwright/test';

const STAFF_EMAIL = 'mia@example.com';
const STAFF_PASSWORD = 'salon-demo-password';
const CUSTOMER = 'Farah Haddad';

/** A 1x1 PNG, the photo staff add on a customer's page. */
const PHOTO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Records every console error, uncaught exception, failed request and HTTP error on the page. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.method()} ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return problems;
}

// Names a staff member's photos really have: a non-ASCII letter, a macOS screenshot (its name has a
// narrow no-break space, U+202F, before "AM"), and a "#". Each must be added like any other photo.
const NAMES = ['café.png', 'Screenshot 2026-10-08 at 10.00.00 AM.png', 'cut #2.png'];

for (const name of NAMES) {
  test(`staff add a photo named ${JSON.stringify(name)} and see it on the customer's page`, async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF_EMAIL);
    await page.getByLabel('Password').fill(STAFF_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/appointments$/);

    await page.goto('/customers');
    await page.getByRole('link', { name: CUSTOMER }).click();
    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const photos = page.getByRole('img', { name: 'Customer photo' });
    const before = await photos.count();
    const srcsBefore = await photos.evaluateAll((images) => images.map((image) => image.getAttribute('src')));

    await page.getByLabel('Add photo').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(PHOTO_PNG, 'base64') });
    await expect(photos).toHaveCount(before + 1);
    await expect(page.getByText('The photo could not be added.')).toHaveCount(0);
    await page.waitForLoadState('networkidle');

    const added = (await photos.evaluateAll((images) => images.map((image) => image.getAttribute('src')))).filter(
      (src) => !srcsBefore.includes(src),
    );
    expect(added).toHaveLength(1);
    // The stored file keeps its extension: the name is not cut short at a "#" or "?".
    expect(new URL(added[0]!).pathname).toMatch(/\.png$/);
    const image = photos.and(page.locator(`img[src="${added[0]}"]`));
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);

    expect(problems).toEqual([]);
  });
}
