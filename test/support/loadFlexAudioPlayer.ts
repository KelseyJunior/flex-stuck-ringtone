import { createRequire } from 'module';

import { collectFlexAudioPlayerModules, FLEX_UI_VERSION } from './flexAudioModules';
import { FlexAudioPlayer, instantiateFlexAudioPlayer, ModuleFactory } from './flexRuntime';

export type { AudioPlayerError, FlexAudioPlayer } from './flexRuntime';
export { FLEX_UI_VERSION };

const requireFromHere = createRequire(__filename);

/**
 * Loads the real `AudioPlayerManager` shipped in the installed `@twilio/flex-ui` bundle,
 * in Node, without loading the rest of Flex (which needs a full browser, React, …).
 *
 * `AudioPlayerManager`, `AudioPlayer`, `MediaQueue` and `AudioErrorCode` run exactly as
 * shipped (see `flexAudioModules.js`); `queue` and `uuid` are the real packages.
 *
 * `globalThis.Audio` must be installed first (see `FakeAudio`).
 */
export const loadFlexAudioPlayer = (): FlexAudioPlayer => {
  if (typeof (globalThis as { Audio?: unknown }).Audio !== 'function') {
    throw new Error('Install a global `Audio` (FakeAudio) before loading the Flex audio player.');
  }

  const modules = collectFlexAudioPlayerModules();
  const factories: Record<string, ModuleFactory> = {};
  const externals: Record<string, unknown> = {};

  for (const [id, code] of Object.entries(modules.factories)) {
    // eslint-disable-next-line no-eval
    factories[id] = (0, eval)(`(${code})`);
  }
  for (const [id, { dir }] of Object.entries(modules.externals)) {
    externals[id] = requireFromHere(dir);
  }

  return instantiateFlexAudioPlayer({
    factories,
    externals,
    managerId: modules.managerId,
    errorCodeId: modules.errorCodeId
  });
};
