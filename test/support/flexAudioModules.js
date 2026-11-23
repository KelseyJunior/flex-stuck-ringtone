// @ts-check
'use strict';

/**
 * Finds the audio player modules inside the installed `@twilio/flex-ui` bundle.
 *
 * The bundle is a webpack build: every module is a `<id>: function (module, exports,
 * require) { … }` entry of one big object. This parses the bundle and returns, as source
 * text taken verbatim from it:
 *
 * - the modules that make up the audio player (`AudioPlayerManager`, `AudioPlayer`,
 *   `MediaQueue`, `AudioErrorCode`), recognised by what they define;
 * - the webpack externals they use (`module.exports = require("<package>")`, i.e. `queue`
 *   and `uuid`), mapped to the package directory Flex itself resolves them to.
 *
 * Any other module they reach (logger, `ErrorManager`, error messages) is left out: the
 * runtime (`flexRuntime.ts`) replaces it with an inert stub, since none takes part in playback.
 *
 * Plain CommonJS so that both Jest and the demo server (plain Node) can use it.
 */

const { readFileSync } = require('fs');
const { createRequire } = require('module');
const path = require('path');
const { parse } = require('acorn');

const bundlePath = require.resolve('@twilio/flex-ui');
const requireFromFlex = createRequire(bundlePath);

/** @type {string} */
const FLEX_UI_VERSION = requireFromFlex('@twilio/flex-ui/package.json').version;

const MANAGER_MARKER = 't.AudioPlayerManager=new ';
const ERROR_CODE_MARKER = 'e[e.NotAllowed=0]="NotAllowed"';

/** Modules evaluated as shipped, recognised by what they define. */
const REAL_MODULE_MARKERS = [
  MANAGER_MARKER, // AudioPlayerManager
  'isCurrentlyPlaying=function', // AudioPlayer
  't.MediaQueue=void 0', // MediaQueue
  't.AudioErrorCode=void 0' // AudioErrorCode
];

const EXTERNAL_MODULE = /^\(?\w+\)?=>\{"use strict";\w+\.exports=require\("([^"]+)"\)\}$/;

/**
 * @typedef {{ id: string, code: string, requireName: string | undefined }} ModuleSource
 * @typedef {{
 *   version: string,
 *   factories: Record<string, string>,
 *   externals: Record<string, { name: string, dir: string }>,
 *   managerId: string,
 *   errorCodeId: string
 * }} FlexAudioPlayerModules
 */

/** @type {FlexAudioPlayerModules | undefined} */
let cached;

/**
 * The webpack module map: the object with the most `<number>: function` entries.
 * @returns {Map<string, ModuleSource>}
 */
const readBundleModules = () => {
  const source = readFileSync(bundlePath, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest' });
  /** @type {Map<string, ModuleSource>} */
  let best = new Map();

  /** @param {any} node */
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.type === 'ObjectExpression' && node.properties.length > best.size) {
      /** @type {Map<string, ModuleSource>} */
      const found = new Map();

      for (const property of node.properties) {
        const isModule =
          property.type === 'Property' &&
          property.key?.type === 'Literal' &&
          typeof property.key.value === 'number' &&
          /FunctionExpression$/.test(property.value?.type ?? '');

        if (isModule) {
          const id = String(property.key.value);
          const requireParam = property.value.params[2];
          found.set(id, {
            id,
            code: source.slice(property.value.start, property.value.end),
            requireName: requireParam?.type === 'Identifier' ? requireParam.name : undefined
          });
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

  return best;
};

/** @returns {FlexAudioPlayerModules} */
const collectFlexAudioPlayerModules = () => {
  if (cached) {
    return cached;
  }

  const modules = readBundleModules();

  /** @param {string} marker */
  const find = (marker) => {
    const matches = [...modules.values()].filter((module) => module.code.includes(marker));

    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one module containing "${marker}" in @twilio/flex-ui ${FLEX_UI_VERSION}, found ${matches.length}. ` +
          'This Flex UI version may have reorganised its audio player.'
      );
    }

    return matches[0].id;
  };

  const managerId = find(MANAGER_MARKER);
  const errorCodeId = find(ERROR_CODE_MARKER);

  /** @type {Record<string, string>} */
  const factories = {};
  /** @type {Record<string, { name: string, dir: string }>} */
  const externals = {};
  const queue = [managerId, errorCodeId];

  while (queue.length > 0) {
    const id = /** @type {string} */ (queue.pop());
    const module = modules.get(id);

    if (!module || factories[id] || externals[id]) {
      continue;
    }

    const external = EXTERNAL_MODULE.exec(module.code);

    if (external) {
      const name = external[1];
      externals[id] = { name, dir: path.dirname(requireFromFlex.resolve(`${name}/package.json`)) };
      continue;
    }

    if (!REAL_MODULE_MARKERS.some((marker) => module.code.includes(marker))) {
      continue; // stubbed by the runtime
    }

    factories[id] = module.code;

    if (module.requireName) {
      const calls = new RegExp(`\\b${module.requireName}\\((\\d+)\\)`, 'g');
      for (const match of module.code.matchAll(calls)) {
        queue.push(match[1]);
      }
    }
  }

  cached = { version: FLEX_UI_VERSION, factories, externals, managerId, errorCodeId };

  return cached;
};

module.exports = { collectFlexAudioPlayerModules, FLEX_UI_VERSION };
