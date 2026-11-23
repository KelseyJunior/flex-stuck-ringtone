/**
 * The workaround, installed the way a Flex plugin does it, against the real Flex UI audio
 * player and the same race as `flexAudioPlayerRace.test.ts`.
 */
import { CHECK_INTERVAL_MS, CHECK_WINDOW_MS, installRingtoneGuard } from '../src/ringtoneGuard';
import { FakeAudio } from './support/FakeAudio';
import { goUnavailable, RINGTONE_URL, startFlex, wait } from './support/flexHarness';
import { FLEX_UI_VERSION } from './support/loadFlexAudioPlayer';

const ONE_MINUTE = 60_000;

/** A Flex session with the workaround installed by a plugin's `init(flex, manager)`. */
const startFlexWithGuard = () => {
  const session = startFlex();
  installRingtoneGuard(session.flex as never, session.manager as never);
  return session;
};

/** Two reservations arrive while the first ringtone loads, then the agent goes unavailable. */
const triggerRace = async ({ worker }: ReturnType<typeof startFlex>) => {
  worker.receive('WR1');
  worker.receive('WR2');
  await goUnavailable(worker);
};

describe(`ringtoneGuard on Flex UI ${FLEX_UI_VERSION}`, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('releases the ringtone the race leaves looping', async () => {
    const session = startFlexWithGuard();

    await triggerRace(session);
    await wait(FakeAudio.loadTimeMs + CHECK_INTERVAL_MS);

    expect(session.audible()).toEqual([]);
    expect(session.AudioPlayerManager.isPlaying()).toBe(false);

    await wait(ONE_MINUTE);
    expect(session.audible()).toEqual([]);
  });

  it('hides the spurious "Error playing media" the race raises', async () => {
    const session = startFlexWithGuard();

    await triggerRace(session);
    await wait(ONE_MINUTE);

    expect(session.notifications.shown).toEqual([]);
  });

  it('leaves Flex ringing and stopping the next reservations normally', async () => {
    const session = startFlexWithGuard();
    await triggerRace(session);
    await wait(ONE_MINUTE);

    const next = session.worker.receive('WR3');
    await wait(FakeAudio.loadTimeMs);
    expect(session.audible()).toEqual([RINGTONE_URL]);

    next.end('accepted');
    await wait(ONE_MINUTE);
    expect(session.audible()).toEqual([]);
  });

  it('does not touch a ringtone while a reservation is still pending, and releases it once none is', async () => {
    const session = startFlexWithGuard();
    const [first, second] = [session.worker.receive('WR1'), session.worker.receive('WR2')];

    // The race already strikes here: rejecting WR1 drops WR2's ringtone from Flex's queue
    // while it goes on to load and loop. WR2 is still pending, so that sound is legitimate.
    first.end('rejected');
    await wait(CHECK_WINDOW_MS);
    expect(session.audible()).toEqual([RINGTONE_URL]);

    // Flex can no longer stop it when WR2 ends; the guard does.
    second.end('rejected');
    await wait(CHECK_INTERVAL_MS);
    expect(session.audible()).toEqual([]);
  });

  it('changes nothing when there is no race', async () => {
    const session = startFlexWithGuard();

    const reservation = session.worker.receive('WR1');
    await wait(FakeAudio.loadTimeMs);
    expect(session.audible()).toEqual([RINGTONE_URL]);

    reservation.end('rejected');
    await wait(ONE_MINUTE);

    expect(session.audible()).toEqual([]);
    expect(session.notifications.shown).toEqual([]);
  });
});
