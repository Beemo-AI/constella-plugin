# Constella memory in Codex

Checked against Codex CLI `codex-cli 0.153.2` on 2026-11-24. Codex changes fast. If a flag here is missing in your version, `codex --help` is right and this page is wrong.

Want to be walked through it? Do step 1, then start Codex in your repo and run the `constella:init` skill. It checks each step with you, one at a time.

## The short way

```sh
npx -y github:Beemo-AI/constella-plugin setup
```

It signs you in once in the browser, installs the plugin, and writes the `constella` server (with your key) into `~/.codex/config.toml`, so steps 1, 2 and 3 below are done for you. The Codex CLI, the Codex app and the IDE extension share that file. Step 4, trusting the hooks, is still yours: Codex wants a person to do it. If you let Codex run the command and it asks to approve it (it needs the network and your home folder), say yes. You can also paste the setup prompt from the [main README](../README.md#set-up-in-one-step) into Codex and let it run the command.

The steps below are the same thing by hand.

## Setup

### 1. Install

```sh
# From GitHub, or from a clone on your machine:
codex plugin marketplace add Beemo-AI/constella-plugin
codex plugin marketplace add /path/to/constella-plugin   # the local way

codex plugin add constella@constella
```

This gives Codex the MCP server, the three skills and the hooks. No plugin? See [By hand](#by-hand-no-plugin).

### 2. Sign in

```sh
codex mcp login constella
```

The browser opens. Sign in to Constella. This is what lets the tools (`memory_recall`, `memory_add`) work.

Check: `codex mcp list` shows `constella` and its `Auth` column no longer says `Not logged in`.

### 3. Give the hooks a key

The sign-in is for the tools. The hooks are small scripts, and they cannot use that sign-in. They need a key of their own.

Make a key in the Constella desktop app (**Settings > Developer**). Put it in your shell profile (`~/.zshrc` or `~/.bashrc`), then open a new terminal:

```sh
export CONSTELLA_API_KEY="csk_..."
```

Without the key, the tools still work. The AI just has to call `memory_recall` itself (the `constella:memory` skill tells it when).

Check, from your repo folder. It prints one line per check and never shows the key:

```sh
node ~/.codex/plugins/cache/constella/constella/0.1.0/scripts/constella.mjs doctor
```

```
ok    node  v22.11.0
ok    repo  acme/web-app (branch main)
ok    key   a key is set (not shown)
ok    api   https://api.constella.app answered; the key works
```

### 4. Trust the hooks

Codex does not run a hook until you say it is safe. Until then the hooks do nothing, and Codex does not tell the AI. An AI cannot do this step for you.

- **Codex CLI:** start `codex`, type `/hooks`, and trust every Constella hook in the list (`SessionStart`, `PreToolUse`, and `PreCompact` if it is shown). If hooks are waiting, Codex prints a warning at start that tells you to open `/hooks`.
- **Codex desktop app:** click **Review hooks** in the composer, or open **Settings > Hooks**.

Codex saves your yes in `~/.codex/config.toml`, as a hash of the hook:

```toml
[hooks.state."<key>"]
trusted_hash = "sha256:..."
```

If the hook changes, the hash no longer matches. Codex skips the hook again until you trust it again. So after you update this plugin, open `/hooks` once more.

Then start a new session. The start hook only runs when a session starts.

### 5. Optional: pick how much Codex may do without asking

This step is not needed for Constella. It is about how often Codex stops to ask you.

Two things decide it. The **sandbox** says what commands can touch. The **approval policy** says when Codex asks first.

| What you want | Start Codex with | In the desktop app |
|---|---|---|
| Ask before leaving the project folder (the normal way) | `codex --sandbox workspace-write --ask-for-approval on-request` | **Ask for approval** |
| Middle: stay in the project folder, a reviewer AI answers the questions | `codex --approve-for-me` | **Approve for me** |
| Middle: stay in the project folder, never ask | `codex --sandbox workspace-write --ask-for-approval never` | (no button) |
| Full access: no sandbox, never ask. Same idea as Claude Code's `--dangerously-skip-permissions` | `codex --dangerously-bypass-approvals-and-sandbox` (short: `codex --yolo`) | **Full access** |

- In the desktop app and the IDE extension, the choice is the permissions control below the box you type in.
- In a running CLI session, type `/permissions` to change it.
- `codex --sandbox danger-full-access --ask-for-approval never` is the same as full access, written with the two separate flags.
- In "never ask" inside the project folder, a command that needs more (the network, a file outside the folder) just fails. Codex does not ask.
- `codex exec` (no chat window) takes `--sandbox`, `--approve-for-me` and `--dangerously-bypass-approvals-and-sandbox`.
- `--full-auto` is gone in this version. `--ask-for-approval` only takes `on-request` and `never`.

**The risk of full access:** Codex can then run any command, change or delete any file your user can, and use the network, all without asking. Use it only where a mistake is cheap, like a throwaway machine or a container.

To make a choice stick, put it in `~/.codex/config.toml`:

```toml
# Middle: stay in the project folder, a reviewer AI answers the questions.
sandbox_mode = "workspace-write"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
```

Or keep full access in its own file, so you only get it when you ask for it. Make `~/.codex/full.config.toml`:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

Then start with `codex --profile full`.

Full access does not trust hooks. Step 4 is still needed.

**Constella tools without a question each time.** Codex may ask before it runs an MCP tool. To let the two memory tools run without asking, add this to `~/.codex/config.toml`:

```toml
[plugins."constella@constella".mcp_servers.constella.tools.memory_recall]
approval_mode = "approve"

[plugins."constella@constella".mcp_servers.constella.tools.memory_add]
approval_mode = "approve"
```

For every tool of the server at once, use one line instead: `default_tools_approval_mode = "approve"` under `[plugins."constella@constella".mcp_servers.constella]`. If you set the server up by hand, the tables start with `[mcp_servers.constella` instead. The other values are `auto`, `prompt` and `writes` (`writes` asks only for tools that are not marked read-only).

### 6. Check it works

1. Open a terminal in a git repo and start a new Codex session.
2. Ask: `What does your Constella memory block say? Show its first line.`
3. You should see a line that starts like this:

```
Constella memory (repo: acme/web-app, branch: main)
```

Under it are the last handoff, the rules and the decisions saved for that repo (or a note that nothing is saved yet).

4. Ask: `Call memory_recall for this repo.` It should answer without an error. `/mcp` lists the Constella tools.

### If it does not work

- **No memory block at all.** The hooks are not trusted, or the session is older than the trust. Type `/hooks`, trust them, start a new session. Updated the plugin? Trust them again.
- **The block says "not loaded automatically".** It starts with `Constella memory is connected for this repo`. The hooks run, but they have no key, or the key is wrong, or the server was too slow. Run the `doctor` command from step 3. Its `key` and `api` lines say which.
- **`doctor` says the key is set, but the block still says "not loaded".** Codex was started from a place that does not have the key. A terminal opened before you edited your shell profile is one. The desktop app started from the Dock may be another (not checked here); try starting it from a terminal with `codex app`.
- **`doctor` says `FAIL api ... could not be reached` when the AI runs it.** The sandbox blocks the network for the AI's commands. Run `doctor` in your own terminal instead.
- **`memory_recall` fails or asks you to sign in.** Run `codex mcp login constella` again. `codex mcp list` shows the sign-in state.
- **Codex stops with an error about the model.** The model named in your Codex settings is not one your account or this Codex version can use. Pick another with `/model`, or start with `codex -m <model>`. This is not a Constella problem, but no session means no hooks.
- **Memory shows up for the wrong repo.** Check `git remote get-url origin`. The `repo` line of `doctor` shows what the hooks will use.
- **Still stuck.** Set `CONSTELLA_DEBUG=1`, start a new session, and read `debug.log` in the plugin's data folder (see the main README).

For scripts only: `codex exec --dangerously-bypass-hook-trust ...` runs the hooks for one run without trusting them. Do not use it as your normal way in.

## By hand (no plugin)

Use this in place of step 1. Steps 2 to 6 stay the same.

MCP server, with a browser sign-in:

```sh
codex mcp add constella --url https://api.constella.app/mcp
codex mcp login constella
```

Or, with a key instead of a sign-in, put this in `~/.codex/config.toml`:

```toml
[mcp_servers.constella]
url = "https://api.constella.app/mcp"
bearer_token_env_var = "CONSTELLA_API_KEY"

[mcp_servers.constella.http_headers]
X-Constella-Client = "codex"
X-Constella-Tools = "catalog"
```

`X-Constella-Client = "codex"` files your saves under Codex. `X-Constella-Tools = "catalog"` asks for the current tool names (`memory_recall`, `memory_add`).

Skills: copy the three folders in `skills/` into `~/.agents/skills/` (Codex reads skills from there), or use `npx skills add Beemo-AI/constella-plugin -a codex -g` (see the main README; not run here).

Hooks: copy `codex/hooks.json` into `~/.codex/hooks.json` (merge it if you already have one), replace `/ABSOLUTE/PATH/TO/constella-plugin` with the real folder, then trust the hooks with `/hooks` (step 4). These hooks pass `--client codex`, so the server knows the caller is Codex.

The `doctor` command is then at `/path/to/constella-plugin/scripts/constella.mjs`.

## How Codex reads the plugin

- `.claude-plugin/marketplace.json` is the marketplace. Codex reads this Claude-style file.
- `.codex-plugin/plugin.json` points Codex at `codex/mcp.json`. That file has the plain URL `https://api.constella.app/mcp`, because Codex does not fill in `${VAR:-default}` the way Claude Code does.
- `hooks/hooks.json` is the same file Claude Code uses. Codex gives the hook `CLAUDE_PLUGIN_ROOT` (and its own `PLUGIN_ROOT`).
- Skills show up as `constella:memory`, `constella:init` and `constella:handoff`.

## What is different from Claude Code

- Codex edits files with `apply_patch`. The hook reads the file names from the patch (`*** Update File: ...`).
- Codex ignores the text a PreCompact hook prints, so the plugin's compact hook prints nothing there. After a compaction Codex starts the context again with SessionStart `source: "compact"`, and the hook adds the "save a handoff now" line then.
- The hook sends `X-Constella-Client: codex`. It knows it runs in Codex from the `--client codex` argument, Codex's `turn_id` field, the `apply_patch` tool, a transcript under `.codex`, or Codex's `PLUGIN_ROOT` variable.
- Codex lists `constella:init` as a skill the model may pick by itself. Claude Code keeps it for the user only (`disable-model-invocation`). Codex does not seem to read that field.
- Claude Code runs a plugin's hooks once the plugin is installed. Codex waits for you to trust them (step 4).

## Turn the hooks off

- Only Constella: `codex plugin remove constella@constella` (or remove the lines from `~/.codex/hooks.json`). You can also switch one hook off in `/hooks`.
- All hooks: add this to `~/.codex/config.toml`, or start Codex with `--disable hooks`:

```toml
[features]
hooks = false
```

## What was checked, and how

Every claim on this page is in one of three lists. "Run here" means it was run on this machine with Codex CLI 0.153.2. Nothing in the real `~/.codex` was changed for these checks.

### Run here, in a real Codex session

- Hooks that are not trusted do nothing, and nothing is shown to the AI.
- Trust is stored in `config.toml` as `[hooks.state."<key>"]` with `trusted_hash = "sha256:..."`.
- With trust skipped for one run (`--dangerously-bypass-hook-trust`), the SessionStart hook and the PreToolUse hook (matcher `apply_patch|Edit|Write`) both ran. The start block reached the model. The hook saw the host as `codex`. File names were read from `apply_patch`.
- Hooks can be given for one run with `-c 'hooks.SessionStart=[{hooks=[{type="command",command="node /path/constella-hook.mjs start --client codex",timeout=5}]}]'`.

### Run here, with a throwaway `CODEX_HOME` and no model session

- `codex plugin marketplace add <folder>` reads `.claude-plugin/marketplace.json` and adds marketplace `constella`.
- `codex plugin add constella@constella` installs it into `$CODEX_HOME/plugins/cache/constella/constella/0.1.0`.
- `codex mcp list` then shows server `constella` at `https://api.constella.app/mcp`, with `Auth` = `Not logged in` before the sign-in. Without `.codex-plugin/plugin.json` it showed the raw text `${CONSTELLA_MCP_URL:-https://api.constella.app/mcp}`, which is why that file exists.
- `http_headers` in a plugin MCP file is read (`codex mcp get constella` lists them).
- The by-hand `config.toml` block parses: `codex mcp get constella` shows the bearer variable and both headers.
- `codex debug prompt-input` lists the three skills as `constella:handoff`, `constella:init`, `constella:memory`.
- `codex mcp add constella --url ...` writes `[mcp_servers.constella]` with `url = ...`.
- The flags, from `codex --help` and `codex exec --help`: `--sandbox` (`read-only`, `workspace-write`, `danger-full-access`), `--ask-for-approval` (`on-request`, `never` only), `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--profile`. `codex exec --help` has no `--ask-for-approval`.
- `--yolo` is not in `--help`, but the CLI takes it. `codex --yolo debug prompt-input` shows `sandbox_mode` `danger-full-access`, approval policy `never`, network on.
- `--full-auto` is refused (`unexpected argument`). `--ask-for-approval untrusted` and `on-failure` are refused.
- A profile file works: with `full.config.toml` as in step 5, `codex --profile full debug prompt-input` shows `danger-full-access` and approval `never`.
- `-c 'approval_policy="never"' -c 'sandbox_mode="workspace-write"'` gives approval `never`, sandbox `workspace-write`, and "Network access is restricted" in the text Codex gives the model.
- `default_tools_approval_mode = "approve"` under `[plugins."constella@constella".mcp_servers.constella]` parses, and `codex mcp get constella` shows it. A wrong value is refused with the list `auto`, `prompt`, `writes`, `approve`.
- The `doctor` command: by the plugin's own tests (`npm test`), against a fake server.

### From the docs only (not run here)

- `/hooks` in the CLI, **Review hooks** and **Settings > Hooks** in the desktop app, the warning at start, and that a new or changed hook is skipped until trusted, also when a plugin update changes a script (https://learn.chatgpt.com/docs/hooks.md). Typing `/hooks` needs a person, so it was not run by the AI that wrote this.
- That plugin hooks get `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`, the SessionStart and PreToolUse shapes, and that PreCompact output is ignored (same page). The hook's tests use those shapes.
- The desktop app names **Ask for approval**, **Approve for me** and **Full access**, in the permissions control below the composer, and `/permissions` in the CLI (https://learn.chatgpt.com/docs/permission-modes.md, https://learn.chatgpt.com/docs/sandboxing.md).
- That full access means `sandbox_mode = "danger-full-access"` with `approval_policy = "never"` (https://learn.chatgpt.com/docs/sandboxing.md), and that `--yolo` is the short name of `--dangerously-bypass-approvals-and-sandbox` (https://learn.chatgpt.com/docs/agent-approvals-security.md).
- `approvals_reviewer = "auto_review"` and what the reviewer does (https://learn.chatgpt.com/docs/sandboxing/auto-review.md). **Approve for me** may be missing for some accounts or organizations.
- The MCP approval keys and the `approve` example (https://learn.chatgpt.com/docs/extend/mcp.md, https://learn.chatgpt.com/docs/config-file/config-reference.md). The docs say tools marked destructive always ask.
- That `codex mcp login constella` works for a server that comes from a plugin.

### Not confirmed

- What `approve` and `auto` do exactly. The docs list the four values and show `approve` in the example, but do not spell each one out. Whether an MCP tool still asks in full access mode was not tested.
- That full access leaves hook trust alone. It follows from the two separate flags and the docs, but was not tried in a session.
- Whether the desktop app, started from the Dock, sees `CONSTELLA_API_KEY` from a shell profile.
- Whether a command the AI runs in Codex sees `CONSTELLA_API_KEY`. Codex can filter variables out of the AI's shell. That is why the `init` skill asks you to run `doctor` yourself when the AI's run says the key is missing.
- The "error about the model" line was seen once here: `codex exec` stopped with "model is not supported when using Codex with a ChatGPT account" until it was started with `-m <another model>`.
