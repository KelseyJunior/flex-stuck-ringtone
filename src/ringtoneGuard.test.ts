import { EventEmitter } from 'events';

import {
  ABORT_ERROR_WINDOW_MS,
  CHECK_INTERVAL_MS,
  CHECK_WINDOW_MS,
  installRingtoneGuard,
  SILENT_WAV
} from './ringtoneGuard';

type Status = 'pending' | 'accepted' | 'rejected' | 'timeout' | 'canceled' | 'rescinded';

class FakeReservation extends EventEmitter {
  constructor(
    readonly sid: string,
    public status: Status = 'pending'
  ) {
    super();
  }

  end(status: Exclude<Status, 'pending'>): void {
    this.status = status;
    this.emit(status, this);
  }
}

class FakeWorker extends EventEmitter {
  readonly reservations = new Map<string, FakeReservation>();

  receive(sid: string): FakeReservation {
    const reservation = new FakeReservation(sid);
    this.reservations.set(sid, reservation);
    this.emit('reservationCreated', reservation);
    return reservation;
  }
}

const setup = () => {
  const worker = new FakeWorker();
  const notifications = new EventEmitter();
  const AudioPlayerManager = {
    isPlaying: jest.fn(() => false),
    play: jest.fn(() => 'silent-media-id'),
    stop: jest.fn()
  };
  const flex = { AudioPlayerManager, Notifications: notifications };

  installRingtoneGuard(flex as never, { workerClient: worker } as never);

  /** Fires `beforeAddNotification` like Flex does and reports whether it was cancelled. */
  const isCancelled = (id: string): boolean => {
    const cancel = jest.fn();
    notifications.emit('beforeAddNotification', { id }, cancel);
    return cancel.mock.calls.length > 0;
  };

  return { worker, AudioPlayerManager, isCancelled };
};

describe('installRingtoneGuard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('stuck ringtone', () => {
    it.each(['accepted', 'rejected', 'timeout', 'canceled', 'rescinded'] as const)(
      'releases a ringtone still playing after the last reservation is %s',
      (status) => {
        const { worker, AudioPlayerManager } = setup();
        const reservation = worker.receive('WR1');
        AudioPlayerManager.isPlaying.mockReturnValue(true);

        reservation.end(status);
        jest.advanceTimersByTime(CHECK_INTERVAL_MS);

        expect(AudioPlayerManager.play).toHaveBeenCalledWith(
          { url: SILENT_WAV, repeatable: true },
          expect.any(Function)
        );
        expect(AudioPlayerManager.stop).toHaveBeenCalledWith('silent-media-id');
      }
    );

    /** The stuck loop only starts once its file has loaded, after the reservation ended. */
    it('catches a ringtone that starts looping a few seconds after the reservations end', () => {
      const { worker, AudioPlayerManager } = setup();
      worker.receive('WR1').end('rejected');

      jest.advanceTimersByTime(3_000);
      expect(AudioPlayerManager.play).not.toHaveBeenCalled();

      AudioPlayerManager.isPlaying.mockReturnValue(true);
      jest.advanceTimersByTime(CHECK_INTERVAL_MS);

      expect(AudioPlayerManager.stop).toHaveBeenCalledTimes(1);
    });

    it('leaves the ringtone alone while another reservation is still pending', () => {
      const { worker, AudioPlayerManager } = setup();
      const first = worker.receive('WR1');
      worker.receive('WR2');
      AudioPlayerManager.isPlaying.mockReturnValue(true);

      first.end('rejected');
      jest.advanceTimersByTime(CHECK_WINDOW_MS);

      expect(AudioPlayerManager.play).not.toHaveBeenCalled();
      expect(AudioPlayerManager.stop).not.toHaveBeenCalled();
    });

    it('does nothing when no sound is playing', () => {
      const { worker, AudioPlayerManager } = setup();

      worker.receive('WR1').end('rejected');
      jest.advanceTimersByTime(CHECK_WINDOW_MS);

      expect(AudioPlayerManager.play).not.toHaveBeenCalled();
    });

    it('stops checking once the window is over', () => {
      const { worker, AudioPlayerManager } = setup();
      worker.receive('WR1').end('rejected');

      jest.advanceTimersByTime(CHECK_WINDOW_MS);
      AudioPlayerManager.isPlaying.mockReturnValue(true);
      jest.advanceTimersByTime(CHECK_WINDOW_MS);

      expect(AudioPlayerManager.play).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps a single timer when many reservations end together', () => {
      const { worker } = setup();
      const reservations = ['WR1', 'WR2', 'WR3'].map((sid) => worker.receive(sid));

      reservations.forEach((reservation) => reservation.end('rejected'));

      expect(jest.getTimerCount()).toBe(1);
    });
  });

  describe('"Error playing media" notification', () => {
    it('hides the AbortError Flex reports right after a reservation ends', () => {
      const { worker, isCancelled } = setup();

      worker.receive('WR1').end('rejected');

      expect(isCancelled('AudioPlayerGenericError')).toBe(true);
    });

    it('still shows a playback error that has nothing to do with a reservation ending', () => {
      const { worker, isCancelled } = setup();
      worker.receive('WR1');

      expect(isCancelled('AudioPlayerGenericError')).toBe(false);
    });

    it('still shows the error once the window after the reservation ended is over', () => {
      const { worker, isCancelled } = setup();
      worker.receive('WR1').end('rejected');

      jest.advanceTimersByTime(ABORT_ERROR_WINDOW_MS);

      expect(isCancelled('AudioPlayerGenericError')).toBe(false);
    });

    it('never hides other notifications', () => {
      const { worker, isCancelled } = setup();
      worker.receive('WR1').end('rejected');

      expect(isCancelled('AudioPlayerDeniedError')).toBe(false);
      expect(isCancelled('AudioPlayerInvalidMediaError')).toBe(false);
    });
  });

  it('does nothing without a TaskRouter worker', () => {
    const flex = { AudioPlayerManager: {}, Notifications: { addListener: jest.fn() } };

    installRingtoneGuard(flex as never, {} as never);

    expect(flex.Notifications.addListener).not.toHaveBeenCalled();
  });
});
