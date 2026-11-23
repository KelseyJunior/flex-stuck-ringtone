/**
 * A stand-in for the browser's `HTMLAudioElement`, implementing the parts of the HTML
 * media element spec the Flex audio player relies on:
 *
 * - `play()` returns a promise that resolves once the media has loaded (`loadTimeMs`,
 *   driven by Jest's fake timers), and the element then plays — forever, if `loop` is set;
 * - `pause()` while a `play()` is pending rejects it with an `AbortError`
 *   ("The play() request was interrupted by a call to pause()");
 * - assigning `src` runs the load algorithm: playback stops, and a pending `play()` is
 *   rejected with an `AbortError` ("…interrupted by a new load request");
 * - promise rejections are delivered as microtasks, like in a browser.
 *
 * `ended` is never fired on its own, since every ringtone loops. The Flex player
 * dispatches `ended` itself, which is exactly where the bug lives.
 *
 * `FakeAudio.audible()` tells what a person in front of the screen would hear.
 */

interface PendingPlay {
  resolve: () => void;
  reject: (error: DOMException) => void;
}

export class FakeAudio extends EventTarget {
  /** How long a media file takes to load before it starts playing. */
  static loadTimeMs = 300;

  static instances: FakeAudio[] = [];

  loop = false;
  muted = false;
  currentTime = 0;
  paused = true;

  private currentSrc = '';
  private loadedSrc: string | null = null;
  private pendingPlays: PendingPlay[] = [];
  private loadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(src?: string) {
    super();
    FakeAudio.instances.push(this);

    if (src) {
      this.src = src;
    }
  }

  static install(): void {
    FakeAudio.instances = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  }

  /** URLs that are audibly playing right now, across every audio element. */
  static audible(): string[] {
    return FakeAudio.instances
      .filter((audio) => audio.isAudible)
      .map((audio) => audio.src);
  }

  get src(): string {
    return this.currentSrc;
  }

  set src(value: string) {
    // Media element load algorithm.
    if (!this.paused) {
      this.paused = true;
      this.rejectPendingPlays('The play() request was interrupted by a new load request.');
    }
    clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    this.loadedSrc = null;
    this.currentSrc = value;
  }

  get isAudible(): boolean {
    return !this.paused && !this.muted && this.currentSrc !== '' && this.loadedSrc === this.currentSrc;
  }

  play(): Promise<void> {
    this.paused = false;

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingPlays.push({ resolve, reject });
    });

    if (this.loadedSrc === this.currentSrc) {
      this.resolvePendingPlays();
    } else if (!this.loadTimer) {
      const src = this.currentSrc;
      this.loadTimer = setTimeout(() => {
        this.loadTimer = undefined;
        if (this.currentSrc === src) {
          this.loadedSrc = src;
          this.resolvePendingPlays();
        }
      }, FakeAudio.loadTimeMs);
    }

    return promise;
  }

  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.rejectPendingPlays('The play() request was interrupted by a call to pause().');
    }
  }

  private resolvePendingPlays(): void {
    const plays = this.pendingPlays;
    this.pendingPlays = [];
    plays.forEach((play) => play.resolve());
  }

  private rejectPendingPlays(message: string): void {
    const plays = this.pendingPlays;
    this.pendingPlays = [];
    plays.forEach((play) => play.reject(new DOMException(message, 'AbortError')));
  }
}
