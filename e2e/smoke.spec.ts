import { expect, test, type Page } from '@playwright/test';

// The seeded staff account and one seeded customer with appointments (demo/supabase/seed.sql).
const STAFF_EMAIL = 'mia@example.com';
const STAFF_PASSWORD = 'salon-demo-password';
const SEEDED_CUSTOMER = 'Aisha Rahman';

/** Records every console error, uncaught exception, failed request and HTTP error on the page. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('requestfailed', (request) =>
    problems.push(`request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  return problems;
}

test('the public booking page renders its booking form', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto('/');

  await expect(page.getByText('Book an appointment', { exact: true })).toBeVisible();
  for (const field of ['Name', 'Phone', 'Email (optional)', 'Service', 'Date', 'Time']) {
    await expect(page.getByLabel(field, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Book', exact: true })).toBeEnabled();
  await page.waitForLoadState('networkidle');

  expect(problems).toEqual([]);
});

test('staff sign in and see the seeded appointments', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto('/login');

  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/appointments$/);
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: SEEDED_CUSTOMER }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(problems).toEqual([]);
});

test('the sign-in page offers a password reset, and the reset page renders', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto('/login');

  await expect(page.getByRole('button', { name: 'Forgot your password?' })).toBeVisible();
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await expect(page.getByText('Enter your email address first.')).toBeVisible();

  await page.goto('/reset-password');
  await expect(page.getByLabel('New password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save new password' })).toBeEnabled();
  await page.waitForLoadState('networkidle');

  expect(problems).toEqual([]);
});
