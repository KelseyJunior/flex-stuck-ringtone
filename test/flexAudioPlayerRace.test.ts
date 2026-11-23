/**
 * Reproduces the bug against the real Flex UI audio player, with no workaround installed.
 *
 * Every test drives the `AudioPlayerManager`, `AudioPlayer` and `MediaQueue` modules
 * loaded straight from the installed `@twilio/flex-ui` bundle (see
 * `support/loadFlexAudioPlayer.ts`), through Flex's own ringtone logic
 * (see `support/flexHarness.ts`).
 */
import { FakeAudio } from './support/FakeAudio';
import { EVENT_GAP_MS, goUnavailable, RINGTONE_URL, startFlex, wait } from './support/flexHarness';
import { FLEX_UI_VERSION } from './support/loadFlexAudioPlayer';

const ONE_MINUTE = 60_000;

describe(`Flex UI ${FLEX_UI_VERSION} audio player, without the workaround`, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('works as expected', () => {
    it('rings for a reservation and stops when it is rejected', async () => {
      const { worker, audible, notifications } = startFlex();

      const reservation = worker.receive('WR1');
      await wait(FakeAudio.loadTimeMs);
      expect(audible()).toEqual([RINGTONE_URL]);

      reservation.end('rejected');
      await wait(ONE_MINUTE);

      expect(audible()).toEqual([]);
      expect(notifications.shown).toEqual([]);
    });

    it('stops the ringtone when the agent goes unavailable with several reservations, if the ringtone had already loaded', async () => {
      const { worker, audible, notifications } = startFlex();

      worker.receive('WR1');
      await wait(FakeAudio.loadTimeMs);
      worker.receive('WR2'); // not queued: Flex skips it because a sound is already playing
      await wait(EVENT_GAP_MS);

      await goUnavailable(worker);
      await wait(ONE_MINUTE);

      expect(audible()).toEqual([]);
      expect(notifications.shown).toEqual([]);
    });
  });

  describe('the race: reservations arrive while the first ringtone is still loading', () => {
    it.each([2, 3, 5])(
      'leaves the ringtone looping forever after %i reservations are rejected, and shows "Error playing media"',
      async (count) => {
        const { worker, audible, notifications, AudioPlayerManager } = startFlex();

        // `isPlaying()` only turns true once `play()` resolves, so while the first ringtone
        // loads Flex does not skip the next reservations: their ringtones get queued.
        for (let i = 1; i <= count; i += 1) {
          worker.receive(`WR${i}`);
          await wait(EVENT_GAP_MS / count);
        }
        expect(audible()).toEqual([]);

        await goUnavailable(worker);
        await wait(ONE_MINUTE);

        expect(worker.pending()).toEqual([]);
        expect(notifications.shown).toContain('AudioPlayerGenericError');
        expect(AudioPlayerManager.isPlaying()).toBe(true);
        expect(audible()).toEqual([RINGTONE_URL]);
      }
    );

    it('needs the rejections to arrive in separate JavaScript tasks: in a single task the ringtone stops (with a spurious "Error playing media" per ringtone)', async () => {
      const { worker, audible, notifications } = startFlex();
      worker.receive('WR1');
      worker.receive('WR2');

      worker.pending().forEach((reservation) => reservation.end('rejected'));
      await wait(ONE_MINUTE);

      expect(audible()).toEqual([]);
      expect(notifications.shown).toEqual(['AudioPlayerGenericError', 'AudioPlayerGenericError']);
    });

    it('already strikes while a reservation is still pending: Flex can no longer stop its ringtone when it ends', async () => {
      const { worker, audible } = startFlex();
      const [first, second] = [worker.receive('WR1'), worker.receive('WR2')];

      first.end('rejected'); // drops WR2's ringtone from the queue, but it still loads and loops
      await wait(ONE_MINUTE);
      expect(audible()).toEqual([RINGTONE_URL]);

      second.end('rejected');
      await wait(ONE_MINUTE);
      expect(audible()).toEqual([RINGTONE_URL]);
    });

    it('keeps looping through later reservations: they get no ringtone of their own and their end does not stop it', async () => {
      const { worker, audible } = startFlex();
      worker.receive('WR1');
      worker.receive('WR2');
      await goUnavailable(worker);
      await wait(ONE_MINUTE);
      expect(audible()).toEqual([RINGTONE_URL]);

      // The agent comes back and gets a new reservation, then accepts it.
      const next = worker.receive('WR3');
      await wait(ONE_MINUTE);
      next.end('accepted');
      await wait(ONE_MINUTE);

      expect(audible()).toEqual([RINGTONE_URL]);
    });
  });
});
