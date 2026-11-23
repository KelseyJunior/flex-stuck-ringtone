# Flex UI: ringtone keeps looping after the agent goes unavailable

A reproduction, root-cause analysis and workaround for a race in the Twilio Flex UI audio
player (**`@twilio/flex-ui` 2.18.0**).

When several reservations reach an agent while the first ringtone is still loading, and
the agent then switches to an unavailable activity (for example Offline), Flex:

1. shows the error notification **"Error playing media."** (`AudioPlayerGenericError`);
2. can leave the ringtone **looping with no pending reservation**. Nothing in Flex stops
   it any more. Later reservations don't get their own ringtone, and their end doesn't
   stop the loop either. Only a page reload stops it.

Everything in this repository runs the **actual audio player code shipped in the
`@twilio/flex-ui` package**, not a copy of it (see [How the tests work](#how-the-tests-work)).

```sh
npm install
npm test                         # Jest: the race step by step, on a simulated <audio>
npx playwright install chromium  # once
npm run test:browser             # Playwright: the same race in a real Chromium
npm run demo                     # open http://localhost:4173 and listen to it
```

### See and hear it in your browser

`npm run demo` serves a page that runs the real Flex UI audio player through your
browser's own `<audio>` element. The ringtone is served with a 1.5 s delay, which
stands for a slow network or a large file. Turn your sound on, then:

1. Pick **Without the fix** and click **Run the scenario**. Two reservations arrive
   and the agent goes Offline before the ringtone has loaded. "Error playing media." shows
   up, and a moment later the ringtone starts and loops forever, with no pending
   reservation.
2. Pick **With the fix** and run the same scenario. The ringtone stops within half a second
   of starting, and no error is shown.

The page shows what the agent hears, `AudioPlayerManager.isPlaying()`, the state of the
`<audio>` element, the reservations and a log of events. The step-by-step buttons let you
play other sequences. `?delay=<ms>` changes the ringtone's load time.

---

## Contents

- [Environment](#environment)
- [Reproducing it in a real Flex instance](#reproducing-it-in-a-real-flex-instance)
- [Root cause](#root-cause)
- [Step by step](#step-by-step)
- [Why it is intermittent](#why-it-is-intermittent)
- [Possible fixes in Flex UI](#possible-fixes-in-flex-ui)
- [The workaround](#the-workaround)
- [How the tests work](#how-the-tests-work)
- [Project layout](#project-layout)

---

## Environment

| | |
|---|---|
| Flex UI | `@twilio/flex-ui` 2.18.0 |
| TaskRouter SDK | `twilio-taskrouter` 2.1.1 (as bundled with Flex UI 2.18.0) |
| Ringtones | Set through `SoundManager.configure`, looping (`repeatable: true`) |
| Browsers | Chrome (desktop) |

## Reproducing it in a real Flex instance

1. Give the agent a capacity that allows two or more reservations at the same time (for
   example, several chat tasks).
2. Make the ringtone slow to load: open DevTools → Network → throttle to *Slow 3G*, or
   point the channel's pending sound at a large file.
3. While the agent is Available, route two or more tasks to them within a fraction of a
   second.
4. While the first ringtone is still loading, switch the agent to an unavailable
   activity (Offline or Unavailable) that rejects pending reservations.

**Expected:** the ringtone stops, and no error is shown.

**Actual:** "Error playing media." is shown, and often a ringtone starts a moment later
and loops until the page is reloaded, with no pending reservation.

## Root cause

The relevant modules of the Flex UI bundle, de-minified (names as in the shipped
`.d.ts` files).

**`AudioPlayer`**: one per media manager, wrapping a **single shared `<audio>` element**:

```js
play(url, repeat, onAudioEnd, onError) {
  this.audio.src = url;
  this.audio.loop = repeat;
  this.onAudioEnd = onAudioEnd;
  this.onError = onError;
  this.isLoading = true;
  this.audio.addEventListener('ended', this.handleAudioEnded);
  this.playAudio();
}

async playAudio() {
  try {
    await this.audio.play();
    this.isPlaying = true;          // (A) set even if this play() is no longer the current one
    this.isLoading = false;
  } catch (error) {
    this.handlePlayError(error);    // (B) AbortError ends up here too
  }
}

handlePlayError(error) {
  const audioError = this.getAudioPlayerError(error);  // AbortError → AudioErrorCode.Other
  this.onError?.(audioError);                          //   → "Error playing media."
  if (audioError.code === AudioErrorCode.NotAllowed) this.handlePlayNotAllowedError();
  else this.audio.dispatchEvent(new Event('ended'));   // (C) received by whichever job listens *now*
  this.isPlaying = false;
  this.isLoading = false;
}

handleAudioEnded = () => {
  this.isPlaying = false;
  this.isLoading = false;
  this.audio.removeEventListener('ended', this.handleAudioEnded);
  this.onAudioEnd();                                   // tells the queue the current job is done
};

stop() {
  if (this.isPlaying || this.isLoading) {
    this.audio.pause();                                // rejects a pending play() with AbortError
    this.isPlaying = false;
    this.isLoading = false;
  }
  this.audio.dispatchEvent(new Event('ended'));
}

isCurrentlyPlaying() { return this.isPlaying; }        // false while loading
```

**`AudioPlayerManager`**: one queue plus one `AudioPlayer` for repeatable media, and the
same for non-repeatable media:

```js
play(mediaData, onError) {
  const id = uuid();
  const manager = this.getMediaManager(mediaData);
  manager.queue.enqueue(id, (done) =>
    manager.audioPlayer.play(mediaData.url, mediaData.repeatable, this.onAudioEnd(done, id), onError));
  this.medias.set(id, mediaData);
  return id;
}

onAudioEnd = (done, id) => () => { done(); this.medias.delete(id); };

stop(id) {
  if (!this.medias.has(id)) return;                    // (D) a job dropped by (C) can't be stopped
  const manager = this.getMediaManager(this.medias.get(id));
  if (manager.queue.isProcessing(id)) manager.audioPlayer.stop();
  manager.queue.dequeue(id);
  this.medias.delete(id);
}

isPlaying() {
  return this.repeatableMediaManager.audioPlayer.isCurrentlyPlaying()
      || this.nonRepeatableMediaManager.audioPlayer.isCurrentlyPlaying();
}
```

**`WorkerListener`**: plays the channel's pending sound on `reservationCreated` and
stops it when the reservation is accepted, rejected, timed out, canceled or rescinded:

```js
shouldSkipTask(task) {
  return isOutboundCallTask(task) || workerStatus.isBusyWithVoice
      || AudioPlayerManager.isPlaying();               // (E) false while a ringtone is loading
}
```

Together:

- **(E)** While the first ringtone loads, `isPlaying()` is `false`, so Flex doesn't skip
  the next reservations: their ringtones get **queued** behind it.
- **(B)** and **(C)**: stopping a ringtone that is still loading rejects its `play()` with
  an `AbortError`. That error is reported as a generic error ("Error playing media.") and
  then answered with a synthetic `ended` on the shared element. By the time that rejection
  is handled, the queue has already started the **next** job, which has attached its own
  `ended` listener. So the stale `ended` ends **the next job**: the queue drops it and
  `medias` forgets its id.
- **(A)** The dropped job's own `play()` is still pending. It resolves once its file loads,
  sets `isPlaying = true`, and the element loops.
- **(D)** When that reservation is rejected a moment later, `stop(id)` returns early:
  the id is gone from `medias`. Nothing will ever pause the element.
- **(E)** again: while it loops, `isPlaying()` is `true`, so every new reservation is
  skipped. It gets no ringtone of its own, and its `stopSound` has no media id to stop.

## Step by step

Two reservations, WR1 and WR2, reach an Available agent within the ringtone's load time.
The agent then goes Offline, and TaskRouter rejects both (two websocket messages).

| # | Event | Flex audio player | `<audio>` |
|---|---|---|---|
| 1 | `reservationCreated` WR1 | `play` → job 1 starts, `isLoading` | `src = ring`, `play()` #1 pending |
| 2 | `reservationCreated` WR2 | `isPlaying()` is `false` → `play` → job 2 **queued** | |
| 3 | WR1 `rejected` | `stop(job 1)` → `pause()`, synthetic `ended` → job 1 done → **job 2 starts**, attaches `ended` listener | `play()` #1 rejected (AbortError), `src = ring`, `play()` #2 pending |
| 4 | *(microtask)* | `play()` #1's `AbortError` → **"Error playing media."** → synthetic `ended` → **job 2's listener** → job 2 done, `medias.delete(job 2)` | `play()` #2 still pending |
| 5 | *(file loaded)* | `play()` #2 resolves → `isPlaying = true` | **loops** |
| 6 | WR2 `rejected` | `stop(job 2)` → not in `medias` → **no-op** | **loops forever** |

With more reservations the same thing cascades: every stale `ended` drops the job that
was started next. The last one is left looping. The tests check this with 2, 3 and 5
reservations.

## Why it is intermittent

All three conditions must hold:

- **Several reservations arrive while the first ringtone is still loading.** Once a
  ringtone has loaded, `isPlaying()` is `true` and later reservations are skipped, not
  queued. A slow network or a large file widens the window.
- **The reservations end while the next job is waiting for its file.** That job must
  already be loading when the stale `AbortError` arrives.
- **The ends arrive as separate JavaScript tasks.** TaskRouter delivers each event as its
  own websocket message, so in practice they always do. When all the stops happen in
  one task, each `AbortError` arrives after the queue is empty: nothing gets stuck, and
  only the spurious "Error playing media." is shown. A test covers this case too.

## Possible fixes in Flex UI

Any one of these would remove the bug:

1. **Ignore outcomes of superseded `play()` calls.** Give each `AudioPlayer.play` a
   token, and in `playAudio` drop both the success (A) and the error (B) when the token
   is no longer the current one:

   ```js
   play(url, repeat, onAudioEnd, onError) {
     const token = ++this.playToken;
     /* …as today… */
     this.playAudio(token);
   }

   async playAudio(token) {
     try {
       await this.audio.play();
       if (token !== this.playToken) return;     // superseded: someone else owns the element now
       this.isPlaying = true;
       this.isLoading = false;
     } catch (error) {
       if (token !== this.playToken) return;     // stale AbortError: don't report, don't dispatch `ended`
       this.handlePlayError(error);
     }
   }

   stop() { this.playToken++; /* …as today… */ }
   ```

2. **Don't dispatch a synthetic `ended` on the shared element** to finish a job. Call the
   current job's `onAudioEnd` directly, so an event can't reach a different job.

3. **Don't report `AbortError`** as an error. It means "your own `pause()`/`src` change
   interrupted this `play()`", which is what `stop()` asked for.

4. **Have `shouldSkipTask` also consider a loading ringtone** (`isLoading`), so
   reservations arriving during the load aren't queued at all.

## The workaround

[`src/ringtoneGuard.ts`](src/ringtoneGuard.ts) is installed from a Flex plugin's `init`.
It only goes through public APIs: `AudioPlayerManager`, `Notifications` and the TaskRouter
`Worker`.

```ts
import { installRingtoneGuard } from './ringtoneGuard';

export default class MyPlugin extends FlexPlugin {
  async init(flex: typeof Flex, manager: Flex.Manager): Promise<void> {
    installRingtoneGuard(flex, manager);
  }
}
```

What it does:

- **Releases a stuck ringtone.** Whenever a reservation leaves the pending state, it
  checks every 500 ms for the next 10 s: if `AudioPlayerManager.isPlaying()` is `true`
  and the worker has **no pending reservation**, the sound is the stuck one. Flex only
  plays ringtones for pending reservations. The guard then plays a silent media and stops
  it right away. Playing it points the shared `<audio>` at a new `src`, which cuts the
  loop. Stopping it pauses the element and hands the player back to Flex, idle. It keeps
  checking for a while, not just once, because the stuck ringtone only starts once its
  file has loaded.
- **Hides the spurious error.** It cancels `AudioPlayerGenericError` in
  `beforeAddNotification` within 1 s of a reservation ending, which is when the
  `AbortError` shows up.

### Review of the workaround

Each step was checked against the 2.18.0 bundle, and the integration tests run it against
the real player:

- **The silent media does reach the player right away.** `MediaQueue` uses the `queue`
  package with `autostart` and `concurrency: 1`. When the queue is idle (it is, since
  the stuck job was already dropped), `push` starts the job synchronously. So
  `queue.isProcessing(id)` is already `true` when `stop(id)` runs, and
  `AudioPlayer.stop()` really pauses the element.
- **Releasing the player shows no error.** The silent media's own `AbortError` goes to the
  guard's no-op `onError` callback, not to Flex's `handlePlayError`. Its synthetic `ended`
  finds no listener, because the job already removed it.
- **The notification id is right.** `NotificationIds.AudioPlayerGenericErrorNotificationId`
  is `"AudioPlayerGenericError"`.

Known limitations:

- **It relies on implementation details of 2.18.0:** a single `<audio>` element per player,
  and a queue that starts jobs synchronously. Re-run the tests on every Flex UI upgrade,
  and delete the guard once Flex fixes the race.
- **A genuine `AudioPlayerGenericError` raised within 1 s of a reservation ending is hidden too**
  (for example, a broken URL on a reservation that arrives at that exact moment).
- **A ringtone that takes more than 10 s to load** after the last reservation ended would
  start after the guard stopped checking.
- **Reservations that already exist when the page loads.** Flex doesn't ring them
  (`initAndLoadReservations` never calls `playSound`), so they can't cause the race. But
  TaskRouter emits no `reservationCreated` for them, so the guard doesn't hook their
  events. If such a pending, silent reservation is still around when the race happens,
  it keeps `hasPendingReservation()` `true`, and its own end won't trigger a new check.
  Arming the check on `worker.on('activityUpdated')` as well, and hooking
  `worker.reservations` at init, would close this gap.
- **`isPlaying()` also covers the non-repeatable player.** A short non-looping sound
  inside the window makes the guard play and stop a silent media on the repeatable player
  for nothing. This is harmless.

## How the tests work

| File | What it covers |
|---|---|
| [`test/flexAudioPlayerRace.test.ts`](test/flexAudioPlayerRace.test.ts) | **The bug**, against the real Flex player, with no workaround. Normal cases still work; the race leaves a ringtone looping with 2, 3 and 5 reservations; it only happens when events arrive in separate tasks; it already strikes while a reservation is pending; later reservations neither ring nor stop the loop. |
| [`test/ringtoneGuard.flex.test.ts`](test/ringtoneGuard.flex.test.ts) | **The workaround**, against the same real player and the same race. It releases the loop, hides the spurious error, Flex rings normally afterwards, it doesn't touch a legitimate ringtone, and it changes nothing when there is no race. |
| [`src/ringtoneGuard.test.ts`](src/ringtoneGuard.test.ts) | Unit tests of the workaround's own logic, with a mocked player: timings, statuses, the notification filter. |
| [`e2e/stuckRingtone.spec.ts`](e2e/stuckRingtone.spec.ts) | **The bug and the workaround in a real Chromium** (Playwright, through the demo page). It uses the browser's real `<audio>` and a ringtone served over HTTP with a delay. Without the workaround, the race leaves the element playing (`paused === false`, `currentTime` moving) with no pending reservation, after "Error playing media.". With it, the ringtone stops, no error shows, and the next reservation rings and stops normally. It passed 40 runs out of 40 (`--repeat-each=10`). |

**The Flex code runs as shipped.**
[`test/support/flexAudioModules.js`](test/support/flexAudioModules.js) parses the
installed `node_modules/@twilio/flex-ui/bundle/twilio-flex.prod.js` (a webpack build).
It finds the `AudioPlayerManager`, `AudioPlayer`, `MediaQueue` and `AudioErrorCode`
modules by their content and takes their source verbatim. Then
[`test/support/flexRuntime.ts`](test/support/flexRuntime.ts) instantiates them with a
minimal webpack runtime:
- in Node for Jest, through [`loadFlexAudioPlayer.ts`](test/support/loadFlexAudioPlayer.ts);
- in the browser for the demo and Playwright, bundled by [`demo/server.js`](demo/server.js).

Their webpack externals (`queue`, `uuid`) resolve to the real packages. The logger and
`ErrorManager` are replaced by inert stubs, since they take no part in playback. Loading
the whole bundle outside a full Flex app isn't possible.

**In Jest, the browser is the only thing simulated.**
[`test/support/FakeAudio.ts`](test/support/FakeAudio.ts) implements the parts of the HTML
media element spec the player relies on. The Playwright tests then confirm the same
behaviour with Chromium's real `<audio>`:
- `play()` returns a promise that resolves once the file has loaded (300 ms, on Jest's
  fake timers);
- `pause()` and assigning `src` reject a pending `play()` with an `AbortError`,
  delivered as a microtask, as browsers do.

`FakeAudio.audible()` tells what the agent would actually hear.

**Flex's ringtone logic is reproduced in a few lines**, shared by Jest and the demo.
[`test/support/flexSession.ts`](test/support/flexSession.ts) contains `playSound`,
`stopSound`, `handlePlayError` and `shouldSkipTask` from Flex's `WorkerListener`. The
minified original is quoted next to it. It also has a fake TaskRouter worker that
delivers each reservation event as a separate task, like the websocket does.

To check the tests against another Flex UI version, install it and run them:

```sh
npm install --save-dev --save-exact @twilio/flex-ui@<version>
npm test
```

The loader fails with an explicit message if it can't find the audio player modules in
that bundle.

## Project layout

```
src/
  ringtoneGuard.ts            the workaround
  ringtoneGuard.test.ts       its unit tests
test/
  flexAudioPlayerRace.test.ts reproduction of the bug (real Flex player, Jest)
  ringtoneGuard.flex.test.ts  the workaround against the real Flex player (Jest)
  support/
    flexAudioModules.js       finds the audio player modules in the Flex UI bundle
    flexRuntime.ts            instantiates them (Node and browser)
    loadFlexAudioPlayer.ts    loads them in Node
    flexSession.ts            Flex's ringtone logic + fake TaskRouter worker
    flexHarness.ts            Jest session: the above on FakeAudio and fake timers
    FakeAudio.ts              browser-like HTMLAudioElement
demo/
  server.js                   serves the page, bundles the app, serves a slow ringtone
  index.html, app.ts          the demo page (with / without the fix)
e2e/
  stuckRingtone.spec.ts       the bug and the workaround in a real Chromium
```

Requires Node.js 18 or later.

## License

MIT, see [LICENSE](LICENSE). The Flex UI code quoted in this README and loaded by the tests belongs to Twilio and is distributed under the Apache License 2.0 as part of `@twilio/flex-ui`; it is not included in this repository.
