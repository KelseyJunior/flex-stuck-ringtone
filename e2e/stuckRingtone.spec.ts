/**
 * The bug and the workaround in a real Chromium: the real Flex UI audio player playing
 * through the browser's real `<audio>` element, with the ringtone served over HTTP with a
 * delay (see `demo/`).
 */
import { expect, Page, test } from '@playwright/test';

const RINGTONE_DELAY_MS = 1500;
/** Enough for the ringtone to load and the workaround to run its next check. */
const SETTLE_MS = RINGTONE_DELAY_MS + 1500;

const open = async (page: Page, fix: 'on' | 'off') => {
  // The Flex player warms up with a muted sound from Twilio's CDN; not needed here.
  await page.route('https://media.twiliocdn.com/**', (route) => route.abort());
  await page.goto(`/?fix=${fix}&delay=${RINGTONE_DELAY_MS}`);
  await page.waitForFunction(() => !!window.demo);
};

const state = (page: Page) => page.evaluate(() => window.demo.state());

/** The ringtone is audibly playing: not paused, and its playback position moves. */
const isLooping = async (page: Page): Promise<boolean> => {
  const before = await state(page);
  await page.waitForTimeout(700);
  const after = await state(page);

  return (
    after.ringing &&
    !!before.ringtone &&
    !!after.ringtone &&
    after.ringtone.currentTime !== before.ringtone.currentTime
  );
};

test.describe('Flex as shipped (no workaround)', () => {
  test('rings for a reservation and stops when it is accepted', async ({ page }) => {
    await open(page, 'off');

    await page.evaluate(() => window.demo.receive(1));
    await page.waitForTimeout(SETTLE_MS);
    expect(await isLooping(page)).toBe(true);

    await page.evaluate(() => window.demo.acceptOldest());
    await page.waitForTimeout(500);

    expect(await isLooping(page)).toBe(false);
    expect((await state(page)).notificationsShown).toEqual([]);
  });

  test('the race leaves the ringtone looping with no pending reservation, after "Error playing media."', async ({
    page
  }) => {
    await open(page, 'off');

    await page.evaluate(() => window.demo.reproduce());
    await page.waitForTimeout(SETTLE_MS);

    const after = await state(page);
    expect(after.pending).toBe(0);
    expect(after.notificationsShown).toContain('AudioPlayerGenericError');
    expect(after.isPlaying).toBe(true);
    expect(await isLooping(page)).toBe(true);

    // Still looping much later: nothing will stop it.
    await page.waitForTimeout(5_000);
    expect(await isLooping(page)).toBe(true);
  });
});

test.describe('With the workaround', () => {
  test('the same race: the ringtone stops and no error is shown', async ({ page }) => {
    await open(page, 'on');

    await page.evaluate(() => window.demo.reproduce());
    await page.waitForTimeout(SETTLE_MS);

    const after = await state(page);
    expect(after.pending).toBe(0);
    expect(after.isPlaying).toBe(false);
    expect(await isLooping(page)).toBe(false);
    expect(after.notificationsShown).toEqual([]);
    expect(after.notificationsHidden).toContain('AudioPlayerGenericError');
  });

  test('after the race, the next reservation rings and stops normally', async ({ page }) => {
    await open(page, 'on');
    await page.evaluate(() => window.demo.reproduce());
    await page.waitForTimeout(SETTLE_MS);

    await page.evaluate(() => window.demo.receive(1));
    await page.waitForTimeout(SETTLE_MS);
    expect(await isLooping(page)).toBe(true);

    await page.evaluate(() => window.demo.acceptOldest());
    await page.waitForTimeout(500);
    expect(await isLooping(page)).toBe(false);
  });
});
