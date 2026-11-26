#!/usr/bin/env node
// Claude Code runs this before it connects to the plugin's MCP server (`headersHelper` in claude-code/mcp.json) and adds
// the JSON object printed here to the request headers. With a key (the plugin option, CONSTELLA_API_KEY, or
// the one `constella setup` saved) it prints the Authorization header, so there is no browser sign-in. With
// no key it prints {} and Claude Code signs in through the browser as before. The key goes nowhere but
// stdout, and only when the server Claude Code is about to call is the one the key belongs to.

import { apiBase, apiKey } from './lib/api.mjs';
import { sameServer } from './lib/credentials.mjs';

process.emitWarning = () => {};

function headers(env) {
  const key = apiKey(env);
  if (!key) return {};
  const server = String(env.CLAUDE_CODE_MCP_SERVER_URL || '').trim();
  const wanted = String(env.CONSTELLA_MCP_URL || '').trim() || apiBase(env);
  if (server && !sameServer(server, wanted)) return {};
  return { Authorization: `Bearer ${key}` };
}

let out = {};
try {
  out = headers(process.env);
} catch {
  out = {};
}
process.stdout.write(`${JSON.stringify(out)}\n`);
