/**
 * Browser demo: the real Flex UI audio player (taken verbatim from the installed
 * `@twilio/flex-ui` bundle) playing through the browser's real `<audio>` element, driven
 * by Flex's ringtone logic for a fake TaskRouter worker.
 *
 * `?fix=on` installs the workaround (`src/ringtoneGuard.ts`) the way a plugin does;
 * `?fix=off` (default) runs Flex as shipped.
 *
 * `window.demo` exposes the same controls to the Playwright tests (`e2e/`).
 */
import { FLEX_UI_VERSION, loadFlexAudioPlayer } from 'virtual:flex-audio-player';

import { installRingtoneGuard } from '../src/ringtoneGuard';
import { createFlexSession, EVENT_GAP_MS, goUnavailable } from '../test/support/flexSession';

const params = new URLSearchParams(location.search);
const withFix = params.get('fix') === 'on';
const ringtoneDelayMs = Number(params.get('delay') ?? 1500);
const ringtoneUrl = `${location.origin}/ringtone.wav?delay=${ringtoneDelayMs}`;

// Keep a handle on every <audio> element the Flex player creates, to show what it does.
const audioElements: HTMLAudioElement[] = [];
const NativeAudio = window.Audio;
window.Audio = class TrackedAudio extends NativeAudio {
  constructor(src?: string) {
    super(src);
    audioElements.push(this);
  }
} as typeof Audio;

const player = loadFlexAudioPlayer();
const session = createFlexSession(player, ringtoneUrl);
const { worker, notifications, AudioPlayerManager } = session;

if (withFix) {
  installRingtoneGuard(session.flex as never, session.manager as never);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The shared `<audio>` of the player for repeatable media, which plays every looping
 * ringtone. `AudioPlayerManager` creates it first, in its constructor.
 */
const ringtoneElement = (): HTMLAudioElement | undefined => audioElements[0];

const describeSource = (src: string) =>
  src.startsWith('data:') ? 'silent media (workaround)' : src ? new URL(src).pathname : 'none';

const state = () => {
  const audio = ringtoneElement();
  const playingRingtone = !!audio && audio.src.startsWith(ringtoneUrl.split('?')[0]);

  return {
    withFix,
    flexUiVersion: FLEX_UI_VERSION,
    reservations: [...worker.reservations.values()].map(({ sid, status }) => ({ sid, status })),
    pending: worker.pending().length,
    isPlaying: AudioPlayerManager.isPlaying(),
    ringtone: audio
      ? {
          source: describeSource(audio.src),
          paused: audio.paused,
          currentTime: audio.currentTime,
          readyState: audio.readyState,
          loop: audio.loop
        }
      : null,
    /** The `<audio>` is playing the ringtone: what the agent hears. */
    ringing:
      playingRingtone &&
      !audio.paused &&
      !audio.muted &&
      audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
    notificationsShown: [...notifications.shown],
    notificationsHidden: [...notifications.cancelled]
  };
};

const demo = {
  state,
  receive: (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      worker.receive();
    }
  },
  goOffline: () => goUnavailable(worker, sleep),
  acceptOldest: () => worker.pending()[0]?.end('accepted'),
  /** Two reservations arrive; the agent goes Offline while the ringtone is still loading. */
  reproduce: async () => {
    demo.receive(2);
    await sleep(EVENT_GAP_MS);
    await demo.goOffline();
  }
};

declare global {
  interface Window {
    demo: typeof demo;
  }
}
window.demo = demo;

// ---------------------------------------------------------------- UI

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const log = (message: string, tone: 'info' | 'warn' | 'ok' = 'info') => {
  const item = document.createElement('li');
  item.className = tone;
  item.innerHTML = `<time>${(performance.now() / 1000).toFixed(2)}s</time><span></span>`;
  (item.lastChild as HTMLElement).textContent = message;
  $('#log').prepend(item);
};

const showToast = (id: string) => {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = id === 'AudioPlayerGenericError' ? 'Error playing media.' : id;
  $('#toasts').append(toast);
};

worker.on('reservationCreated', (reservation) => {
  log(`${reservation.sid} arrives (pending)`);
  ['accepted', 'rejected'].forEach((status) =>
    reservation.on(status, () => log(`${reservation.sid} ${status}`))
  );
});

notifications.on('notificationProcessed', (id: string, cancelled: boolean) => {
  if (cancelled) {
    log(`Notification "${id}" hidden by the workaround`, 'ok');
  } else {
    log(`Notification "${id}" shown to the agent`, 'warn');
    showToast(id);
  }
});

$('#mode').textContent = withFix ? 'With the workaround' : 'Flex as shipped (no workaround)';
$('#version').textContent = FLEX_UI_VERSION;
$('#expect').textContent = withFix
  ? 'click "Run the scenario". No error shows. The ringtone starts once its file loads, the workaround sees it ' +
    'playing with no pending reservation and stops it within half a second, and the bell goes back to Silent. ' +
    'Switch to "Without the fix" to compare.'
  : 'click "Run the scenario". "Error playing media." shows right away. About 1.5 s later the ringtone starts and ' +
    'never stops: the bell turns red (Stuck) while both reservations are rejected. Click "Reset" to start over, ' +
    'or switch to "With the fix" to compare.';
$('#delay').textContent = String(ringtoneDelayMs);
document.querySelectorAll<HTMLAnchorElement>('[data-fix]').forEach((link) => {
  const url = new URL(location.href);
  url.searchParams.set('fix', link.dataset.fix as string);
  link.href = url.toString();
  link.setAttribute('aria-current', String((link.dataset.fix === 'on') === withFix));
});

$('#reproduce').addEventListener('click', () => {
  log('Scenario: 2 reservations arrive, the agent goes Offline before the ringtone loads');
  void demo.reproduce();
});
$('#receive-one').addEventListener('click', () => demo.receive(1));
$('#receive-two').addEventListener('click', () => demo.receive(2));
$('#offline').addEventListener('click', () => {
  log('Agent goes Offline: TaskRouter rejects every pending reservation');
  void demo.goOffline();
});
$('#accept').addEventListener('click', () => demo.acceptOldest());
$('#reset').addEventListener('click', () => location.reload());

let wasRinging = false;

const render = () => {
  const current = state();

  if (current.ringing !== wasRinging) {
    wasRinging = current.ringing;
    log(current.ringing ? 'Ringtone starts playing' : 'Ringtone stops', current.ringing ? 'info' : 'ok');
  }

  const stuck = current.ringing && current.pending === 0;
  const bell = $('#bell');
  bell.dataset.state = stuck ? 'stuck' : current.ringing ? 'ringing' : 'silent';
  $('#bell-label').textContent = stuck
    ? 'Ringing with no pending reservation: stuck'
    : current.ringing
      ? 'Ringing'
      : 'Silent';

  $('#pending').textContent = String(current.pending);
  $('#is-playing').textContent = String(current.isPlaying);
  $('#audio').textContent = current.ringtone
    ? `${current.ringtone.source} · paused=${current.ringtone.paused} · currentTime=${current.ringtone.currentTime.toFixed(2)}s · loop=${current.ringtone.loop}`
    : 'not created';
  $('#reservations').innerHTML =
    current.reservations
      .map(({ sid, status }) => `<li><code>${sid}</code><span class="status ${status}">${status}</span></li>`)
      .join('') || '<li class="empty">none yet</li>';

  requestAnimationFrame(render);
};

render();
