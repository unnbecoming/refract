import { expect, test } from '@playwright/test';

test('live request, transcript, filters, raw expiry, responsive layout, and reconnect recovery', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recorder traffic' })).toBeVisible();
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  expect((await nav.boundingBox())?.y).toBeGreaterThan(700);

  const posted = await request.post('http://127.0.0.1:28472/v1/responses', { data: { model: 'gpt-e2e', input: 'browser hello' } });
  expect(posted.ok()).toBe(true);
  await expect(page.getByText('openai').first()).toBeVisible();

  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  await page.getByLabel('Model').fill('gpt-e2e');
  const row = page.getByRole('listitem').first();
  await expect(row).toContainText('openai');
  await row.click();
  await expect(page.getByText('browser answer 1')).toBeVisible();
  await expect(page.getByText('Request inspector')).toBeVisible();

  await page.getByRole('tab', { name: 'Raw opt-in' }).click();
  await page.getByRole('button', { name: 'Open raw inspector' }).click();
  await expect(page.getByText('retained', { exact: true })).toBeVisible();
  await request.get('http://127.0.0.1:28473/expire');
  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  await page.getByRole('listitem').first().click();
  await page.getByRole('tab', { name: 'Raw opt-in' }).click();
  await expect(page.getByRole('heading', { name: 'Raw inspector unavailable' })).toBeVisible();
  await expect(page.getByText(/expired or is no longer retained/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open raw inspector' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await expect(page.getByText('browser answer 1')).toBeVisible();

  await request.get('http://127.0.0.1:28473/gap');
  await expect(page.getByText('live', { exact: true })).toBeVisible({ timeout: 10_000 });
  const second = await request.post('http://127.0.0.1:28472/v1/responses', { data: { model: 'gpt-e2e', input: 'after reconnect' } });
  expect(second.ok()).toBe(true);
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByText('Recent completion')).toBeVisible();
});
