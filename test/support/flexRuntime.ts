/**
 * A minimal webpack runtime that instantiates the Flex UI audio player from the modules
 * collected by `flexAudioModules.js`. Runs both in Node (Jest) and in the browser (demo).
 *
 * Each call returns a fresh `AudioPlayerManager` singleton, so sessions never share state.
 * `Audio` must already be what the player should use when this is called: the singleton
 * creates its `<audio>` elements right away.
 */

export interface AudioPlayerError {
  code: number;
  name: string;
  message: string;
}

export interface FlexAudioPlayer {
  AudioPlayerManager: {
    play(media: { url: string; repeatable: boolean }, onError?: (error: AudioPlayerError) => void): string;
    stop(mediaId: string): void;
    isPlaying(): boolean;
    toggleSound(mute: boolean): void;
  };
  AudioErrorCode: { NotAllowed: number; InvalidMedia: number; Other: number };
}

interface WebpackModule {
  exports: Record<string, unknown>;
}

export type ModuleFactory = (
  this: unknown,
  module: WebpackModule,
  exports: WebpackModule['exports'],
  require: (id: number | string) => unknown
) => void;

export interface FlexAudioPlayerSources {
  /** Module id → factory, as shipped in the Flex UI bundle. */
  factories: Record<string, ModuleFactory>;
  /** Module id → the npm package a webpack external stands for. */
  externals: Record<string, unknown>;
  managerId: string;
  errorCodeId: string;
}

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

export const instantiateFlexAudioPlayer = ({
  factories,
  externals,
  managerId,
  errorCodeId
}: FlexAudioPlayerSources): FlexAudioPlayer => {
  const cache = new Map<string, unknown>();

  const webpackRequire = (rawId: number | string): unknown => {
    const id = String(rawId);

    if (cache.has(id)) {
      return cache.get(id);
    }
    if (id in externals) {
      return externals[id];
    }

    const factory = factories[id];

    if (!factory) {
      return inertStub;
    }

    const module: WebpackModule = { exports: {} };
    cache.set(id, module.exports);
    factory.call(module.exports, module, module.exports, webpackRequire);
    cache.set(id, module.exports);

    return module.exports;
  };

  const { AudioPlayerManager } = webpackRequire(managerId) as Pick<FlexAudioPlayer, 'AudioPlayerManager'>;
  const { AudioErrorCode } = webpackRequire(errorCodeId) as Pick<FlexAudioPlayer, 'AudioErrorCode'>;

  return { AudioPlayerManager, AudioErrorCode };
};
