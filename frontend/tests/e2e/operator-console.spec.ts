import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:3000';

test('public operator journey is resumable and read-only across origins', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText(/Temps réel : connecté/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Synthetic token/i })).toBeVisible();

  await request.post(`${API}/__test/add-launch`);
  await expect(page.getByRole('button', { name: /Second token/i })).toBeVisible();
  await page.getByRole('button', { name: /Synthetic token/i }).click();
  await page.getByRole('link', { name: 'Ouvrir la fiche' }).click();
  await page.getByRole('tab', { name: 'Risque' }).click();
  await expect(page.getByRole('alert', { name: /condition éliminatoire/i })).toBeVisible();
  await page.getByRole('tab', { name: 'Social' }).click();
  await expect(page.getByText('Preuves sociales indisponibles')).toBeVisible();
  await page.getByRole('tab', { name: 'Détenteurs' }).click();
  await expect(page.getByText('Détenteurs observés indisponibles')).toBeVisible();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('QualificationUpdated')).toBeVisible();
  await page.getByRole('link', { name: 'Positions paper' }).click();
  await expect(page.getByText('PAPER_CLOSED')).toBeVisible();
  await page.getByRole('link', { name: 'Santé' }).click();
  await expect(page.getByRole('heading', { name: 'Santé technique' })).toBeVisible();
  await expect(page.getByLabel('Qualification : RUNNING')).toBeVisible();
  await expect(page.getByText('Rapports courants : 2')).toBeVisible();

  const resumeCountBefore = await resumeCount(request);
  await request.post(`${API}/__test/reconnect`);
  await expect.poll(async (): Promise<number> => await resumeCount(request)).toBeGreaterThan(resumeCountBefore);
  await expect.poll(async (): Promise<number> => await activeStreamCount(request)).toBe(1);
  await request.post(`${API}/__test/expire`);
  await expect(page.getByText(/Temps réel : resynchronisation/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Temps réel : connecté/i)).toBeVisible({ timeout: 10_000 });

  const recorded = await (await request.get(`${API}/__test/requests`)).json() as { requests: { method: string }[] };
  expect(recorded.requests.filter((item) => !['GET', 'HEAD', 'OPTIONS'].includes(item.method))).toEqual([]);
});

function isRequestLog(value: unknown): value is { requests: { lastEventId: string | null }[] } {
  if (typeof value !== 'object' || value === null || !('requests' in value) || !Array.isArray(value.requests)) return false;
  return value.requests.every((item: unknown) => typeof item === 'object' && item !== null && 'lastEventId' in item);
}

async function resumeCount(request: { get(url: string): Promise<{ json(): Promise<unknown> }> }): Promise<number> {
  const decoded = await (await request.get(`${API}/__test/requests`)).json();
  if (!isRequestLog(decoded)) return 0;
  return decoded.requests.filter((item) => item.lastEventId !== null).length;
}

async function activeStreamCount(request: { get(url: string): Promise<{ json(): Promise<unknown> }> }): Promise<number> {
  const decoded = await (await request.get(`${API}/__test/state`)).json();
  if (typeof decoded !== 'object' || decoded === null || !('activeStreams' in decoded)) return 0;
  return typeof decoded.activeStreams === 'number' ? decoded.activeStreams : 0;
}
