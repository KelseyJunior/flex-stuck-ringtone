import { FakeAudio } from './FakeAudio';
import { createFlexSession, FakeWorker, goUnavailable as rejectPending } from './flexSession';
import { loadFlexAudioPlayer } from './loadFlexAudioPlayer';

export { EVENT_GAP_MS } from './flexSession';

export const RINGTONE_URL = 'https://example.com/ringtone.mp3';

/**
 * A Flex agent session for Jest: the real Flex audio player, playing through `FakeAudio`,
 * driven by Flex's ringtone logic, for a fake TaskRouter worker.
 *
 * Call it with Jest's fake timers on.
 */
export const startFlex = () => {
  FakeAudio.install();

  return {
    ...createFlexSession(loadFlexAudioPlayer(), RINGTONE_URL),
    /** URLs audibly playing right now. */
    audible: () => FakeAudio.audible()
  };
};

/** Lets time pass, running timers and the promise callbacks they trigger. */
export const wait = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms);

/** The agent goes unavailable: TaskRouter rejects every pending reservation, one message each. */
export const goUnavailable = (worker: FakeWorker): Promise<void> => rejectPending(worker, wait);
