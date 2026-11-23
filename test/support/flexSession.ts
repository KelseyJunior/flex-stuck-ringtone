import { EventEmitter } from 'events';

import { AudioPlayerError, FlexAudioPlayer } from './flexRuntime';

/**
 * Everything around the Flex audio player that the bug and the workaround involve: a
 * TaskRouter worker, `Flex.Notifications`, and Flex's own ringtone logic. Environment
 * agnostic: used by the Jest tests (with `FakeAudio`) and by the browser demo (with the
 * browser's real `<audio>`).
 */

/**
 * TaskRouter delivers each reservation event as its own websocket message, so two events
 * never land in the same JavaScript task. The race needs that gap: a stopped ringtone's
 * `AbortError` is delivered before the next reservation event arrives.
 */
export const EVENT_GAP_MS = 50;

export type ReservationStatus = 'pending' | 'accepted' | 'rejected' | 'timeout' | 'canceled' | 'rescinded';

const ENDED_STATUSES = ['accepted', 'rejected', 'timeout', 'canceled', 'rescinded'] as const;

export class FakeReservation extends EventEmitter {
  constructor(
    readonly sid: string,
    public status: ReservationStatus = 'pending'
  ) {
    super();
  }

  end(status: Exclude<ReservationStatus, 'pending'>): void {
    this.status = status;
    this.emit(status, this);
  }
}

/** The subset of the TaskRouter SDK `Worker` that Flex and the workaround use. */
export class FakeWorker extends EventEmitter {
  readonly reservations = new Map<string, FakeReservation>();
  private count = 0;

  receive(sid = `WR${++this.count}`): FakeReservation {
    const reservation = new FakeReservation(sid);
    this.reservations.set(sid, reservation);
    this.emit('reservationCreated', reservation);
    return reservation;
  }

  pending(): FakeReservation[] {
    return [...this.reservations.values()].filter((reservation) => reservation.status === 'pending');
  }
}

/** `Flex.Notifications`, as far as `showNotification` and `beforeAddNotification` go. */
export class FakeNotifications extends EventEmitter {
  /** Notifications the agent saw. */
  readonly shown: string[] = [];
  /** Notifications a `beforeAddNotification` listener cancelled. */
  readonly cancelled: string[] = [];

  showNotification(id: string): void {
    let cancelled = false;
    this.emit('beforeAddNotification', { id }, () => {
      cancelled = true;
    });

    (cancelled ? this.cancelled : this.shown).push(id);
    this.emit('notificationProcessed', id, cancelled);
  }
}

/**
 * The ringtone part of Flex's `WorkerListener` (`@twilio/flex-ui` 2.18.0), reduced to what
 * matters here. Minified original:
 *
 * ```js
 * shouldSkipTask = function (e) {
 *   var t = TaskHelper.getWorkerStatus().details;
 *   return TaskHelper.isOutboundCallTask(e) || t.isBusyWithVoice || AudioPlayerManager.isPlaying();
 * };
 * playSound = function (e) {
 *   var r = TaskChannels.getForTask(e), i = TaskHelper.getWorkerStatus().busy, o = r.sounds?.Pending;
 *   o && !this.shouldSkipTask(e) &&
 *     (this.currentMediaIds[e.taskSid] = AudioPlayerManager.play(
 *       { url: o.url, repeatable: !i && o.repeatable },
 *       function (e) { n.handlePlayError(e); }));
 * };
 * handlePlayError = function (e) {
 *   var t = e.code === AudioErrorCode.NotAllowed ? "AudioPlayerDeniedError"
 *     : e.code === AudioErrorCode.InvalidMedia ? "AudioPlayerInvalidMediaError"
 *     : "AudioPlayerGenericError";
 *   Notifications.showNotification(t);
 * };
 * stopSound = function (e) {
 *   var t = this.currentMediaIds[e.taskSid];
 *   t ? (AudioPlayerManager.stop(t), delete this.currentMediaIds[e.taskSid])
 *     : AudioPlayerManager.isPlaying() &&
 *       (Object.values(this.currentMediaIds).forEach(function (e) { AudioPlayerManager.stop(e); }),
 *        this.currentMediaIds = {});
 * };
 * ```
 *
 * `playSound` runs on `reservationCreated`, `stopSound` when the reservation is accepted,
 * rejected, timed out, canceled or rescinded. The agent is assumed idle (not busy, no
 * outbound call), which is when ringtones loop.
 */
export class FlexWorkerListener {
  private currentMediaIds: Record<string, string> = {};

  constructor(
    worker: FakeWorker,
    private readonly player: FlexAudioPlayer,
    private readonly notifications: FakeNotifications,
    private readonly ringtoneUrl: string
  ) {
    worker.on('reservationCreated', (reservation: FakeReservation) => {
      ENDED_STATUSES.forEach((status) => reservation.on(status, () => this.stopSound(reservation.sid)));
      this.playSound(reservation.sid);
    });
  }

  private playSound(taskSid: string): void {
    const { AudioPlayerManager } = this.player;

    if (AudioPlayerManager.isPlaying()) {
      return;
    }

    this.currentMediaIds[taskSid] = AudioPlayerManager.play(
      { url: this.ringtoneUrl, repeatable: true },
      (error) => this.handlePlayError(error)
    );
  }

  private handlePlayError(error: AudioPlayerError): void {
    const { AudioErrorCode } = this.player;
    const id =
      error.code === AudioErrorCode.NotAllowed
        ? 'AudioPlayerDeniedError'
        : error.code === AudioErrorCode.InvalidMedia
          ? 'AudioPlayerInvalidMediaError'
          : 'AudioPlayerGenericError';

    this.notifications.showNotification(id);
  }

  private stopSound(taskSid: string): void {
    const { AudioPlayerManager } = this.player;
    const mediaId = this.currentMediaIds[taskSid];

    if (mediaId) {
      AudioPlayerManager.stop(mediaId);
      delete this.currentMediaIds[taskSid];
    } else if (AudioPlayerManager.isPlaying()) {
      Object.values(this.currentMediaIds).forEach((id) => AudioPlayerManager.stop(id));
      this.currentMediaIds = {};
    }
  }
}

/**
 * Wires a Flex agent session around the given audio player.
 *
 * `flex` and `manager` are what a plugin receives in `init(flex, manager)`, as far as the
 * workaround goes.
 */
export const createFlexSession = (player: FlexAudioPlayer, ringtoneUrl: string) => {
  const worker = new FakeWorker();
  const notifications = new FakeNotifications();

  new FlexWorkerListener(worker, player, notifications, ringtoneUrl);

  return {
    worker,
    notifications,
    AudioPlayerManager: player.AudioPlayerManager,
    flex: { AudioPlayerManager: player.AudioPlayerManager, Notifications: notifications },
    manager: { workerClient: worker }
  };
};

/**
 * The agent switches to an unavailable activity (e.g. Offline) and TaskRouter rejects
 * every pending reservation, one websocket message each.
 */
export const goUnavailable = async (
  worker: FakeWorker,
  wait: (ms: number) => Promise<void>
): Promise<void> => {
  for (const reservation of worker.pending()) {
    reservation.end('rejected');
    await wait(EVENT_GAP_MS);
  }
};
