// OpenCode v2 entry point (`@opencode/plugin`).
//
// Uses `Plugin.define` from `@opencode/plugin` when loaded inside OpenCode v2, while staying
// importable in plain Node (zero runtime dependencies) for tests and custom wrappers.

import { createConstellaPlugin, setupConstellaPlugin, PLUGIN_ID } from './plugin.mjs';
import { createClient, resolveConfig } from './client.mjs';
import { formatStartBlock, formatFallbackBlock, formatTurnRecallBlock } from './format.mjs';
import { TranscriptManager, normalizeMessage, normalizeTranscript, latestUserPrompt } from './transcript.mjs';

const definition = createConstellaPlugin();

let pluginExport = definition;
try {
  const sdk = await import('@opencode/plugin');
  if (sdk?.Plugin && typeof sdk.Plugin.define === 'function') {
    pluginExport = sdk.Plugin.define(definition);
  }
} catch {
  // `@opencode/plugin` is provided by the OpenCode v2 host runtime; fallback keeps pure Node imports working.
}

export default pluginExport;

export {
  PLUGIN_ID,
  createConstellaPlugin,
  setupConstellaPlugin,
  createClient,
  resolveConfig,
  formatStartBlock,
  formatFallbackBlock,
  formatTurnRecallBlock,
  TranscriptManager,
  normalizeMessage,
  normalizeTranscript,
  latestUserPrompt,
};
