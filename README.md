# Flex UI: ringtone keeps looping after the agent goes unavailable

A reproduction, root-cause analysis and workaround for a race in the Twilio Flex UI audio
player (`@twilio/flex-ui` 2.18.0).

When several reservations reach an agent while the first ringtone is still loading, and
the agent then switches to an unavailable activity (e.g. Offline), Flex shows
"Error playing media." and can leave the ringtone looping with no pending reservation.
Nothing in Flex stops it afterwards, and new reservations don't get a ringtone of their
own. Only a page reload stops it.

## In plain words

Flex plays every ringtone through one shared `<audio>` element, with a queue in front of it.

1. Two reservations arrive. The first ringtone starts loading; the second waits in the queue.
2. Before the sound has loaded, the agent goes Offline and both reservations are rejected.
3. Flex stops the first ringtone. The browser cancels the load, and Flex reports that
   cancellation as an error: "Error playing media.".
4. While handling that error, Flex fires a "finished" event on the shared element. The
   second ringtone has just started loading and receives it, so Flex drops it from its
   list, but its sound keeps loading.
5. The sound finishes loading and loops.
6. When Flex is asked to stop the second ringtone, it's no longer on its list, so nothing
   happens.

It needs reservations to arrive while a ringtone is loading and to end before it has
loaded, so it is intermittent and more frequent on slow networks.

## Try it

```sh
npm install
npx playwright install chromium  # once
npm test                         # Jest, on a simulated <audio>
npm run test:browser             # Playwright, in a real Chromium
npm run demo                     # http://localhost:4173
```

The demo runs the Flex audio player through your browser's `<audio>`, with the ringtone
served after a 1.5 s delay (`?delay=<ms>` to change it). Turn the sound on, click
**Run the scenario** without the fix, then with it.

All of it runs the audio player code shipped in `@twilio/flex-ui`, unmodified
(see [How the tests work](#how-the-tests-work)).

## Reproducing it in a real Flex instance

1. Give the agent capacity for two or more simultaneous reservations (e.g. chat).
2. Make the ringtone slow to load: DevTools → Network → *Slow 3G*, or a large sound file.
3. While the agent is Available, route two or more tasks to them within a fraction of a second.
4. Before the first ringtone has loaded, switch the agent to an activity that rejects
   pending reservations.

Expected: the ringtone stops, no error is shown.
Actual: "Error playing media." is shown, and often a ringtone starts a moment later and
loops until the page is reloaded.

Versions: `@twilio/flex-ui` 2.18.0, `twilio-taskrouter` 2.1.1, ringtones set through
`SoundManager.configure` with `repeatable: true`.

## Root cause

The relevant modules of the Flex UI bundle, de-minified (names from the shipped `.d.ts`).

`AudioPlayer` wraps one `<audio>` element, shared by every job of its queue:

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
  else this.audio.dispatchEvent(new Event('ended'));   // (C) reaches whichever job listens now
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

`AudioPlayerManager` has a queue and an `AudioPlayer` for repeatable media, and another
pair for non-repeatable media:

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

`WorkerListener` plays the pending sound on `reservationCreated` unless it should skip
the task, and stops it when the reservation is accepted, rejected, timed out, canceled or
rescinded:

```js
shouldSkipTask(task) {
  return isOutboundCallTask(task) || workerStatus.isBusyWithVoice
      || AudioPlayerManager.isPlaying();               // (E) false while a ringtone is loading
}
```

Two reservations, WR1 and WR2, reach an Available agent within the ringtone's load time.
The agent goes Offline, and TaskRouter rejects both (two websocket messages):

| # | Event | Flex audio player | `<audio>` |
|---|---|---|---|
| 1 | `reservationCreated` WR1 | `play` → job 1 starts | `play()` #1 pending |
| 2 | `reservationCreated` WR2 | (E) `isPlaying()` is `false` → job 2 queued | |
| 3 | WR1 `rejected` | `stop(job 1)` → `pause()`, `ended` → job 1 done → job 2 starts and attaches its `ended` listener | `play()` #1 rejected (AbortError), `play()` #2 pending |
| 4 | (play #1 rejection handled) | (B) "Error playing media." → (C) `ended` → job 2's listener → job 2 done, removed from `medias` | `play()` #2 still pending |
| 5 | (file loaded) | (A) `play()` #2 resolves → `isPlaying = true` | loops |
| 6 | WR2 `rejected` | (D) `stop(job 2)` → not in `medias` → no-op | loops forever |

With more reservations it cascades: each stale `ended` drops the job started next, and the
last one is left looping. While it loops, (E) skips every new reservation, so they get no
ringtone of their own and nothing to stop.

The rejections must arrive in separate JavaScript tasks, which TaskRouter's websocket
messages always are. If every stop happens in one task, each `AbortError` arrives once
the queue is already empty: nothing gets stuck, and only the error is shown.

## Possible fixes in Flex UI

Any one of these removes the bug:

1. Ignore the outcome of a superseded `play()`: give each `AudioPlayer.play` a token, and
   in `playAudio` drop both the success (A) and the error (B) when the token is stale.

   ```js
   async playAudio(token) {
     try {
       await this.audio.play();
       if (token !== this.playToken) return;     // another job owns the element now
       this.isPlaying = true;
       this.isLoading = false;
     } catch (error) {
       if (token !== this.playToken) return;     // stale AbortError: don't report, don't dispatch `ended`
       this.handlePlayError(error);
     }
   }
   // play(): const token = ++this.playToken; … this.playAudio(token);
   // stop(): this.playToken++; …
   ```

2. Don't dispatch a synthetic `ended` on the shared element to finish a job; call the
   current job's `onAudioEnd` directly.
3. Don't report `AbortError` as an error: it is the expected result of `stop()`.
4. Make `shouldSkipTask` also skip while a ringtone is loading (`isLoading`), so
   reservations arriving during the load aren't queued.

## The workaround

[`src/ringtoneGuard.ts`](src/ringtoneGuard.ts), installed from a Flex plugin's `init`
with `installRingtoneGuard(flex, manager)`. It only uses `AudioPlayerManager`,
`Notifications` and the TaskRouter `Worker`.

- Releases a stuck ringtone. For 10 s after any reservation leaves the pending state,
  it checks every 500 ms whether `AudioPlayerManager.isPlaying()` is `true` while the
  worker has no pending reservation. Flex only rings for pending reservations, so that
  sound is the stuck one. It then plays a silent media and stops it at once: playing it
  points the shared `<audio>` at a new `src`, which cuts the loop, and stopping it leaves
  the player idle. It keeps checking because the stuck ringtone only starts once its
  file has loaded.
- Hides the spurious error. It cancels `AudioPlayerGenericError` in
  `beforeAddNotification` within 1 s of a reservation ending.

Why releasing works on 2.18.0:

- `MediaQueue` uses the `queue` package with `autostart` and `concurrency: 1`, and the
  queue is idle by then, so the silent job starts synchronously: `isProcessing(id)` is
  already `true` when `stop(id)` runs, and `AudioPlayer.stop()` pauses the element.
- The silent media's own `AbortError` goes to the guard's no-op `onError`, not to Flex's
  `handlePlayError`, so no error is shown.

Limitations:

- It depends on 2.18.0 internals: one `<audio>` per player, and a queue that starts jobs
  synchronously. Re-run the tests on every Flex UI upgrade; delete the guard once Flex
  fixes the race.
- A genuine `AudioPlayerGenericError` within 1 s of a reservation ending is hidden too.
- A ringtone that takes more than 10 s to load starts after the guard has stopped checking.
- Reservations already present when the page loads emit no `reservationCreated`, so the
  guard doesn't hook their events. Flex doesn't ring them, but a pending one keeps
  `hasPendingReservation()` true during a race, and its own end won't trigger a new
  check. Also arming the check on `worker.on('activityUpdated')` would cover this.

## How the tests work

| Test | Runs on | Shows |
|---|---|---|
| [`test/flexAudioPlayerRace.test.ts`](test/flexAudioPlayerRace.test.ts) | Jest, `FakeAudio` | The bug, without the workaround: stuck with 2, 3 and 5 reservations, only when the rejections arrive in separate tasks, also while a reservation is still pending, and later reservations neither ring nor stop it. |
| [`test/ringtoneGuard.flex.test.ts`](test/ringtoneGuard.flex.test.ts) | Jest, `FakeAudio` | The workaround on the same race: it releases the loop, hides the error, leaves Flex ringing normally afterwards and leaves a legitimate ringtone alone. |
| [`src/ringtoneGuard.test.ts`](src/ringtoneGuard.test.ts) | Jest, mocked player | The workaround's own logic: timings, statuses, the notification filter. |
| [`e2e/stuckRingtone.spec.ts`](e2e/stuckRingtone.spec.ts) | Playwright, Chromium | Both, with the browser's `<audio>` and a delayed ringtone over HTTP: without the workaround the element keeps playing (`paused === false`, `currentTime` moving) with no pending reservation; with it, it stops. |

The Flex code is not copied.
[`flexAudioModules.js`](test/support/flexAudioModules.js) parses the installed
`@twilio/flex-ui` bundle (a webpack build) and takes the `AudioPlayerManager`,
`AudioPlayer`, `MediaQueue` and `AudioErrorCode` modules verbatim.
[`flexRuntime.ts`](test/support/flexRuntime.ts) runs them with a minimal webpack runtime,
in Node for Jest and bundled for the browser by [`demo/server.js`](demo/server.js). Their
`queue` and `uuid` dependencies are the real packages; the logger and `ErrorManager` are
inert stubs.

What is simulated:

- In Jest, the `<audio>` element ([`FakeAudio.ts`](test/support/FakeAudio.ts)): `play()`
  resolves once the file has loaded, and `pause()` or a new `src` rejects a pending
  `play()` with an `AbortError`, asynchronously. The Playwright tests check the same
  behaviour with Chromium's real element.
- Everywhere, Flex's ringtone logic and TaskRouter
  ([`flexSession.ts`](test/support/flexSession.ts)): `playSound`, `stopSound`,
  `handlePlayError` and `shouldSkipTask` from `WorkerListener`, with the minified
  original quoted, and a fake worker that delivers each reservation event in its own task.

To try another Flex UI version:

```sh
npm install --save-dev --save-exact @twilio/flex-ui@<version>
npm test && npm run test:browser
```

The loader fails with an explicit message if it can't find the audio player modules.

Requires Node.js 18 or later.

## License

MIT, see [LICENSE](LICENSE). The Flex UI code quoted here and loaded by the tests belongs
to Twilio, under the Apache License 2.0, and is not included in this repository.
