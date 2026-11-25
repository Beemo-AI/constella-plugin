// Reading what Claude Code or Codex sends a hook on stdin, and telling the two apart.
// Both send one JSON object with `session_id`, `cwd`, `hook_event_name`, and per event `source`
// (SessionStart) or `tool_name` + `tool_input` (PreToolUse). Codex adds `turn_id` on turn events and edits
// files through `apply_patch`, whose patch text is in `tool_input.command`.

/** Read all of stdin as JSON. Resolves {} when stdin is a terminal, empty, not JSON, or slower than `timeoutMs`. */
export function readStdinJson(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve({});
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

/** The value after `--name` in argv, or ''. */
export function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : '';
}

/**
 * Which AI tool ran the hook: 'codex' or 'claude-code' (or the value of --client / CONSTELLA_CLIENT).
 * Codex is recognised by: `--client codex`, a `turn_id` field, the `apply_patch` tool, a transcript under
 * a `.codex` folder, or Codex's own PLUGIN_ROOT variable (Claude Code does not set it).
 */
export function detectHost(argv, env, input) {
  const named = argValue(argv, '--client') || env.CONSTELLA_CLIENT || '';
  if (named) return /^claude[-_ ]?code$|^claudecode$/i.test(named) ? 'claude-code' : named.toLowerCase();
  if (input && input.turn_id !== undefined) return 'codex';
  if (input && input.tool_name === 'apply_patch') return 'codex';
  if (input && typeof input.transcript_path === 'string' && /[\\/]\.codex[\\/]/.test(input.transcript_path)) return 'codex';
  if (env.PLUGIN_ROOT && !env.CLAUDE_PROJECT_DIR) return 'codex';
  return 'claude-code';
}

/** The hook mode from argv (start | file | compact), else from the event name. '' when unknown. */
export function pickMode(argv, input) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--client') {
      i += 1;
    } else if (['start', 'file', 'compact'].includes(argv[i])) {
      return argv[i];
    }
  }
  const event = input && input.hook_event_name;
  if (event === 'SessionStart') return 'start';
  if (event === 'PreToolUse') return 'file';
  if (event === 'PreCompact') return 'compact';
  return '';
}

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/gm;

/** File paths named in an apply_patch text ("*** Update File: src/a.ts", "*** Move to: src/b.ts"). At most 10. */
export function patchPaths(patch) {
  const out = [];
  for (const re of [PATCH_FILE, PATCH_MOVE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(patch)) !== null) {
      const p = m[1].trim();
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out.slice(0, 10);
}

/**
 * The files a PreToolUse call is about to edit.
 * Claude Code: tool_input.file_path (Edit, Write, MultiEdit) or tool_input.notebook_path (NotebookEdit).
 * Codex: the paths inside the apply_patch text.
 */
export function editedFiles(input) {
  const toolInput = (input && input.tool_input) || {};
  if (typeof toolInput !== 'object') return [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) return [toolInput[key]];
  }
  const patch = [toolInput.command, toolInput.patch, toolInput.input].find((v) => typeof v === 'string') || '';
  if (patch && (input.tool_name === 'apply_patch' || patch.includes('*** Begin Patch'))) return patchPaths(patch);
  return [];
}
