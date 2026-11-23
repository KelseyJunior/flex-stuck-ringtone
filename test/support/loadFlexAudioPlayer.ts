import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { parse } from 'acorn';

/**
 * Loads the real `AudioPlayerManager` shipped in the installed `@twilio/flex-ui` bundle,
 * without loading the rest of Flex (which needs a full browser, React, GoodData, …).
 *
 * The bundle is a webpack build: every module is a `<id>: function (module, exports,
 * require) { … }` entry in one big object. This parses the bundle, picks out the audio
 * player modules by their content and evaluates exactly those, untouched:
 *
 * - `AudioPlayerManager`, `AudioPlayer`, `MediaQueue` and `AudioErrorCode` run as shipped;
 * - modules that are only `module.exports = require("<package>")` (webpack externals such
 *   as `queue` and `uuid`) resolve to the real package, from Flex's own dependencies;
 * - every other module they reach (the logger, `ErrorManager`, error messages) is replaced
 *   by an inert stub, since none of them takes part in playback.
 *
 * Each call returns a fresh `AudioPlayerManager` singleton, so tests never share state.
 * `globalThis.Audio` must be installed before calling it (see `FakeAudio`).
 */

interface ModuleSource {
  id: string;
  code: string;
}

interface WebpackModule {
  exports: Record<string, unknown>;
}

type ModuleFactory = (
  this: unknown,
  module: WebpackModule,
  exports: WebpackModule['exports'],
  require: (id: number | string) => unknown
) => void;

export interface FlexAudioPlayer {
  AudioPlayerManager: {
    play(media: { url: string; repeatable: boolean }, onError?: (error: AudioPlayerError) => void): string;
    stop(mediaId: string): void;
    isPlaying(): boolean;
    toggleSound(mute: boolean): void;
  };
  AudioErrorCode: { NotAllowed: number; InvalidMedia: number; Other: number };
}

export interface AudioPlayerError {
  code: number;
  name: string;
  message: string;
}

const bundlePath = require.resolve('@twilio/flex-ui');
const requireFromFlex = createRequire(bundlePath);

export const FLEX_UI_VERSION: string = requireFromFlex('@twilio/flex-ui/package.json').version;

/** Modules evaluated as shipped, recognised by what they define. */
const REAL_MODULE_MARKERS = [
  't.AudioPlayerManager=new ', // AudioPlayerManager
  'isCurrentlyPlaying=function', // AudioPlayer
  't.MediaQueue=void 0', // MediaQueue
  't.AudioErrorCode=void 0' // AudioErrorCode
];

const EXTERNAL_MODULE = /^\(?\w+\)?=>\{"use strict";\w+\.exports=require\("([^"]+)"\)\}$/;

let modulesById: Map<string, ModuleSource> | undefined;

/** Collects the bundle's webpack module map: the object with the most `<number>: function` entries. */
const readBundleModules = (): Map<string, ModuleSource> => {
  if (modulesById) {
    return modulesById;
  }

  const source = readFileSync(bundlePath, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest' });
  let best: Map<string, ModuleSource> = new Map();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    const n = node as { type?: string; properties?: unknown[] };

    if (n.type === 'ObjectExpression' && Array.isArray(n.properties) && n.properties.length > best.size) {
      const found = new Map<string, ModuleSource>();

      for (const property of n.properties as Array<Record<string, any>>) {
        const isModule =
          property.type === 'Property' &&
          property.key?.type === 'Literal' &&
          typeof property.key.value === 'number' &&
          /FunctionExpression$/.test(property.value?.type ?? '');

        if (isModule) {
          const id = String(property.key.value);
          found.set(id, { id, code: source.slice(property.value.start, property.value.end) });
        }
      }

      if (found.size > best.size) {
        best = found;
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value);
      }
    }
  };

  visit(ast);
  modulesById = best;

  return best;
};

/** Answers every property read and call with itself; never thenable, so it can't be awaited by mistake. */
const inertStub: any = new Proxy(function stub() {}, {
  get: (_target, property) => {
    if (property === '__esModule') {
      return true;
    }
    if (property === 'then' || typeof property === 'symbol') {
      return undefined;
    }
    return inertStub;
  },
  apply: () => inertStub,
  construct: () => inertStub
});

export const loadFlexAudioPlayer = (): FlexAudioPlayer => {
  if (typeof (globalThis as { Audio?: unknown }).Audio !== 'function') {
    throw new Error('Install a global `Audio` (FakeAudio) before loading the Flex audio player.');
  }

  const modules = readBundleModules();
  const isReal = (code: string) => REAL_MODULE_MARKERS.some((marker) => code.includes(marker));
  const cache = new Map<string, unknown>();

  const webpackRequire = (rawId: number | string): unknown => {
    const id = String(rawId);

    if (cache.has(id)) {
      return cache.get(id);
    }

    const module = modules.get(id);
    const external = module && EXTERNAL_MODULE.exec(module.code);

    if (external) {
      const exports = requireFromFlex(external[1]);
      cache.set(id, exports);
      return exports;
    }

    if (!module || !isReal(module.code)) {
      cache.set(id, inertStub);
      return inertStub;
    }

    const webpackModule: WebpackModule = { exports: {} };
    cache.set(id, webpackModule.exports);

    // eslint-disable-next-line no-eval
    const factory = (0, eval)(`(${module.code})`) as ModuleFactory;
    factory.call(webpackModule.exports, webpackModule, webpackModule.exports, webpackRequire);
    cache.set(id, webpackModule.exports);

    return webpackModule.exports;
  };

  const find = (marker: string): string => {
    const matches = [...modules.values()].filter((module) => module.code.includes(marker));

    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one module containing "${marker}" in @twilio/flex-ui ${FLEX_UI_VERSION}, found ${matches.length}.`
      );
    }

    return matches[0].id;
  };

  const { AudioPlayerManager } = webpackRequire(find('t.AudioPlayerManager=new ')) as Pick<
    FlexAudioPlayer,
    'AudioPlayerManager'
  >;
  const { AudioErrorCode } = webpackRequire(find('e[e.NotAllowed=0]="NotAllowed"')) as Pick<
    FlexAudioPlayer,
    'AudioErrorCode'
  >;

  return { AudioPlayerManager, AudioErrorCode };
};
