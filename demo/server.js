// @ts-check
'use strict';

/**
 * Serves the browser demo: `node demo/server.js`, then open http://localhost:4173.
 *
 * - `/`              the demo page;
 * - `/app.js`        the demo app, bundled on every request with esbuild. The Flex UI audio
 *                    player modules are taken verbatim from the installed `@twilio/flex-ui`
 *                    bundle (see `test/support/flexAudioModules.js`);
 * - `/ringtone.wav`  a generated ringtone, served after a delay (`?delay=<ms>`, default
 *                    1500 ms) to stand for a slow network or a large file, which is what
 *                    opens the window for the race. Never cached.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const { collectFlexAudioPlayerModules } = require('../test/support/flexAudioModules');

const PORT = Number(process.env.PORT) || 4173;
const DEFAULT_RINGTONE_DELAY_MS = 1500;
const flexUiDir = path.dirname(require.resolve('@twilio/flex-ui/package.json'));

/** `import … from 'virtual:flex-audio-player'`: the real Flex audio player, for the browser. */
const flexAudioPlayerPlugin = {
  name: 'flex-audio-player',
  /** @param {import('esbuild').PluginBuild} build */
  setup(build) {
    build.onResolve({ filter: /^virtual:flex-audio-player$/ }, (args) => ({
      path: args.path,
      namespace: 'flex-audio-player'
    }));

    build.onLoad({ filter: /.*/, namespace: 'flex-audio-player' }, () => {
      const modules = collectFlexAudioPlayerModules();
      const runtime = path.join(__dirname, '../test/support/flexRuntime.ts');
      const externals = Object.entries(modules.externals)
        .map(([id, { name }]) => `${JSON.stringify(id)}: require(${JSON.stringify(name)})`)
        .join(',\n');
      const factories = Object.entries(modules.factories)
        .map(([id, code]) => `${JSON.stringify(id)}: (${code})`)
        .join(',\n');

      return {
        // Externals resolve from Flex UI's own directory, i.e. to the versions Flex uses.
        resolveDir: flexUiDir,
        loader: 'js',
        contents: `
          // Audio player modules of @twilio/flex-ui ${modules.version}, verbatim.
          const { instantiateFlexAudioPlayer } = require(${JSON.stringify(runtime)});
          const externals = { ${externals} };
          const factories = { ${factories} };
          exports.FLEX_UI_VERSION = ${JSON.stringify(modules.version)};
          exports.loadFlexAudioPlayer = () => instantiateFlexAudioPlayer({
            factories,
            externals,
            managerId: ${JSON.stringify(modules.managerId)},
            errorCodeId: ${JSON.stringify(modules.errorCodeId)}
          });
        `
      };
    });
  }
};

const bundleApp = async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'app.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    plugins: [flexAudioPlayerPlugin],
    logLevel: 'silent'
  });

  return result.outputFiles[0].contents;
};

/** A phone-like ring: two 0.4 s bursts of 440 + 480 Hz, then silence; 2.5 s, loopable. */
const createRingtone = () => {
  const sampleRate = 22050;
  const seconds = 2.5;
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const ringing = t < 0.4 || (t >= 0.6 && t < 1.0);
    const value = ringing ? 0.2 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) : 0;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
};

const ringtone = createRingtone();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

  try {
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(fs.readFileSync(path.join(__dirname, 'index.html')));
      return;
    }

    if (url.pathname === '/app.js') {
      const app = await bundleApp();
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(app);
      return;
    }

    if (url.pathname === '/ringtone.wav') {
      const delay = Number(url.searchParams.get('delay') ?? DEFAULT_RINGTONE_DELAY_MS);
      setTimeout(() => {
        response.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': ringtone.length,
          'Cache-Control': 'no-store'
        });
        response.end(ringtone);
      }, delay);
      return;
    }

    response.writeHead(404).end();
  } catch (error) {
    console.error(error);
    response.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(error));
  }
});

server.listen(PORT, () => {
  console.log(`Flex stuck ringtone demo: http://localhost:${PORT}`);
});
