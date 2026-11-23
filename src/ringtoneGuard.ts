import type * as Flex from '@twilio/flex-ui';

/**
 * Workaround for a race in the Flex UI audio player (reproduced on 2.18.0, reported to
 * Twilio). Drop this module once Flex fixes it.
 *
 * Flex plays every ringtone through one shared `<audio>` element behind a `MediaQueue`.
 * Reservations that arrive while the first ringtone is still loading get queued, because
 * `isPlaying()` is only `true` once `play()` resolves. When the agent goes Unavailable
 * TaskRouter rejects them all, and Flex stops them one by one:
 * - stopping a queued ringtone mid-load makes `play()` reject with `AbortError`, which
 *   Flex reports as "Error playing media" (`AudioPlayerGenericError`);
 * - its error handler then dispatches `ended` on the shared element, which the *next*
 *   queued job receives: the queue drops that job while its audio goes on to load and
 *   loop, so the later `stop()` never pauses it and the ringtone rings until a reload.
 *
 * The guard only goes through the public `AudioPlayerManager` and `Notifications` APIs.
 */

const ENDED_RESERVATION_EVENTS = [
  'accepted',
  'rejected',
  'timeout',
  'canceled',
  'rescinded'
] as const;

/**
 * The stuck ringtone only starts once its file has loaded, so it is checked for a while
 * after each reservation leaves the pending state rather than once.
 */
export const CHECK_INTERVAL_MS = 500;
export const CHECK_WINDOW_MS = 10_000;

/** How long after a reservation ends an `AudioPlayerGenericError` is taken as the `AbortError`. */
export const ABORT_ERROR_WINDOW_MS = 1_000;

const GENERIC_AUDIO_ERROR = 'AudioPlayerGenericError';

/** 10 ms of silence (8 kHz, 8-bit mono). */
export const SILENT_WAV =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

export const installRingtoneGuard = (flex: typeof Flex, manager: Flex.Manager): void => {
  const worker = manager.workerClient;

  if (!worker) {
    return;
  }

  const { AudioPlayerManager } = flex;
  let lastReservationEndedAt = -Infinity;
  let checksLeft = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const hasPendingReservation = (): boolean =>
    Array.from(worker.reservations.values()).some(
      (reservation) => reservation.status === 'pending'
    );

  // Flex only plays ringtones for pending reservations, so a sound with none left is the
  // stuck one. Playing a media points the shared `<audio>` at a new `src`, which cuts the
  // loop, and stopping it right away hands the player back to Flex idle.
  const releaseStuckRingtone = (): void => {
    if (!AudioPlayerManager.isPlaying() || hasPendingReservation()) {
      return;
    }

    AudioPlayerManager.stop(
      AudioPlayerManager.play({ url: SILENT_WAV, repeatable: true }, () => undefined)
    );
  };

  const onReservationEnded = (): void => {
    lastReservationEndedAt = Date.now();
    checksLeft = CHECK_WINDOW_MS / CHECK_INTERVAL_MS;

    if (timer) {
      return;
    }

    timer = setInterval(() => {
      releaseStuckRingtone();
      checksLeft -= 1;

      if (checksLeft <= 0) {
        clearInterval(timer);
        timer = undefined;
      }
    }, CHECK_INTERVAL_MS);
  };

  worker.on('reservationCreated', (reservation) => {
    ENDED_RESERVATION_EVENTS.forEach((event) => reservation.on(event, onReservationEnded));
  });

  // Real failures, e.g. a broken URL when the reservation arrives, still get through.
  flex.Notifications.addListener(
    'beforeAddNotification',
    (notification: Flex.Notification, cancel: () => void) => {
      if (
        notification.id === GENERIC_AUDIO_ERROR &&
        Date.now() - lastReservationEndedAt < ABORT_ERROR_WINDOW_MS
      ) {
        cancel();
      }
    }
  );
};
