# Constella memory for coding agents

One memory for all your AI coding tools.

- Decisions, rules and lessons you save in one tool (Claude Code, Codex, Cursor, others) come back in all the others.
- When a session starts, the AI sees the last handoff, the rules and the decisions for the repo you are in.
- Before the AI edits a folder for the first time, it sees what was saved about that folder.
- When you stop or switch tools, the AI saves a handoff (goal, done, next, open questions), so the next one picks up.
- It all lives in your Constella account, so you can see and change it in the Constella app.

The repo is `Beemo-AI/constella-plugin` on GitHub. You can install from there, or from a clone on your machine with the local folder path.

## What is in here

| Part | What it does |
|---|---|
| `claude-code/mcp.json` | Connects the `constella` MCP server (`memory_recall`, `memory_add` and more). It is not at the repo root on purpose: there, Claude Code would also load it as this folder's own project server. |
| `hooks/hooks.json` + `scripts/constella-hook.mjs` | Loads memory at session start and before edits. Keeps decisions through compaction. |
| `skills/memory` | Tells the AI when to read memory, what to save, and how to hand off. |
| `skills/init` | `/constella:init`: checks the setup (in Codex it walks you through it), then seeds memory from the repo's docs. You pick what is kept. |
| `skills/handoff` | `/constella:handoff`: saves a handoff now. |
| `scripts/constella.mjs` | A tiny command line tool: `setup` (one-step install), `doctor`, and memory commands for shells and cloud agents. |
| `scripts/mcp-headers.mjs` | Hands the saved key to Claude Code's MCP connection, so there is no second sign-in. |
| `AGENTS.snippet.md` | The same rules as a block to paste into `AGENTS.md`, for tools without skills. |
| `codex/`, `cursor/` | Setup for Codex and Cursor. |

No npm packages. It needs Node 18 or newer.

## Set up in one step

Paste this into Claude Code or Codex:

```text
Set up Constella memory for my coding agents. Run this command and wait for it to finish
(give it two minutes; it needs the network and writes to my home folder, so ask me if you need permission):

  npx -y github:Beemo-AI/constella-plugin setup

It opens my browser so I can sign in to Constella. If it says it is still waiting for me, tell me to
finish in the browser, then run the same command again. At the end, tell me the steps it says only I can do.
Never print my API key.
```

Or run the command yourself in a terminal: `npx -y github:Beemo-AI/constella-plugin setup`.

What it does:

1. **Signs you in once**, in your browser, on Constella's own sign-in page (Google, an emailed code, or your password). New here? The same step makes your account. The page says it will hand your API key to this computer; you press **Allow**.
2. **Saves your key** in `~/.constella/credentials.json`, readable only by you. The hooks and the plugin's MCP server read it from there, so there is no second sign-in and nothing to add to your shell profile.
3. **Sets up every AI tool it finds:** the plugin in Claude Code, the plugin and the server entry in Codex, the server entry in Cursor.
4. **Tells you what only you can do.** For Codex that is trusting the hooks (`/hooks`).

It is safe to run again: it repairs and updates. Good to know:

- No browser on this machine (SSH, a cloud box)? Make a key in the Constella app (**Settings > Developer**) and run `CONSTELLA_API_KEY=csk_... npx -y github:Beemo-AI/constella-plugin setup`.
- `--only claude,codex` sets up just those tools. `--no-open` prints the sign-in link instead of opening it.
- `npx -y github:Beemo-AI/constella-plugin logout` forgets the saved key. `doctor` checks the setup.
- Codex keeps the key inside `~/.codex/config.toml` and Cursor inside `~/.cursor/mcp.json` (both are files only you can read). Claude Code's settings never hold it.

## Install by hand

### Claude Code

```sh
claude plugin marketplace add Beemo-AI/constella-plugin
claude plugin install constella@constella
```

Or in one line (Claude Code 2.1.292 or newer): `claude plugin install constella --marketplace Beemo-AI/constella-plugin`.
Inside a session: `/plugin install constella --marketplace Beemo-AI/constella-plugin`.

From this folder on your machine: `claude plugin marketplace add /path/to/constella-plugin`, then `claude plugin install constella@constella`. To try it for one session only: `claude --plugin-dir /path/to/constella-plugin`.

The first time the AI uses a Constella tool, Claude Code opens the browser to sign in to Constella.

If you already added Constella as an MCP server yourself (or as a claude.ai connector), Claude Code keeps yours and skips the plugin's copy of the same server. The hooks and skills still work.

### Codex

```sh
codex plugin marketplace add Beemo-AI/constella-plugin
codex plugin add constella@constella
codex mcp login constella
```

Then two things only you can do:

- **Trust the hooks.** Codex does not run a hook until you say it is safe. Type `/hooks` in the Codex CLI and trust the Constella hooks (desktop app: **Review hooks**, or **Settings > Hooks**). Do it again after a plugin update.
- **Set the key**, so the hooks can load memory by themselves: `export CONSTELLA_API_KEY="csk_..."` in your shell profile.

Or let the AI walk you through it: start Codex in your repo and run the `constella:init` skill.

Want Codex to stop asking for permission? `codex --approve-for-me` is the middle way. `codex --dangerously-bypass-approvals-and-sandbox` (short `--yolo`, **Full access** in the desktop app) is the same idea as Claude Code's `--dangerously-skip-permissions`: Codex can then run any command and change any file without asking. Full access does not trust hooks for you.

All steps, a "check it works" test, a fix list, and a way without the plugin: [codex/README.md](codex/README.md).

### Cursor

Add the server to `~/.cursor/mcp.json` and copy the skills to `~/.cursor/skills/`. Details: [cursor/README.md](cursor/README.md).

### Any other agent

Skills, with the `skills` tool (needs Node 22.20 or newer; not run here):

```sh
npx skills add Beemo-AI/constella-plugin                    # pick agents when asked
npx skills add Beemo-AI/constella-plugin -a claude-code -g  # one agent, for every project
```

MCP server, with the `add-mcp` tool (not run here):

```sh
npx add-mcp https://api.constella.app/mcp -n constella
```

No skills in your tool? Paste [AGENTS.snippet.md](AGENTS.snippet.md) into the repo's `AGENTS.md`.

## The key: optional, but better

Without a key, it works. The tools sign in through the browser. The AI reads memory when the `memory` skill tells it to.

With a key, it is better. The hooks load memory for the repo by themselves at session start and before edits, so the AI never forgets to look.

`constella setup` (above) fetches and saves the key for you. A key is looked for in this order: the plugin option, then `CONSTELLA_API_KEY`, then the file setup saved. The saved key is only ever sent to the server it was saved for.

To do it by hand instead, get a key in the Constella desktop app: **Settings > Developer**. Then give it to the plugin:

- Claude Code: `/plugin configure constella@constella` in a session (it is stored in your system's secure store, not in a settings file). Or from a shell: `claude plugin configure constella@constella --values-stdin < values.json`, where `values.json` holds `{"api_key": "csk_..."}`. Delete that file afterwards.
- Codex, Cursor, scripts and cloud agents: set the environment variable `CONSTELLA_API_KEY`.

The plugin also has a `save_to` setting. It says where new memories go. `me` (your own memory) is the default.

## What leaves your machine

The hooks send only these to `api.constella.app`, over HTTPS:

- the repo name (`owner/name` from the `origin` remote, with any login or token in the URL removed; or the folder name when there is no remote)
- the paths of files the AI is about to edit, relative to the repo (`src/api/users.ts`)

The AI also sends the memories it chooses to save, with `memory_add`.

`constella setup` also sends the email you use for Claude Code (read from `~/.claude.json`) to Constella's sign-in page, only to fill in the email box. Pass `--email ""` to leave it out.

Never sent: file contents, your prompts, the session transcript, the branch name (it only shows up locally, in the text the AI sees), or the key anywhere except the `Authorization` header.

## What is stored where

- **In your Constella account:** the memories (rules, decisions, lessons, facts, handoffs). Each one records which AI tool saved it. You can see, change and delete them in Constella.
- **On this machine:** small files in the plugin's data folder (`~/.claude/plugins/data/...` in Claude Code, Codex's plugin data folder in Codex, else your temp folder under `constella-agent-plugin`):
  - `sessions/<session id>.json`: which folders were already looked up, and which memory ids were already shown, in each session. Deleted after a week.
  - `debug.log`: only when `CONSTELLA_DEBUG=1`.
- **The key:** in `~/.constella/credentials.json` (when `constella setup` saved it; mode 600), in Claude Code's secure store (when set with `/plugin configure`), or in your own environment variable. Setup also writes it into `~/.codex/config.toml` and `~/.cursor/mcp.json` when those tools are found.

## Cloud agents

- **claude.ai and Claude cloud sessions:** add Constella as a connector in claude.ai (URL `https://api.constella.app/mcp`). Cloud sessions use your claude.ai connectors.
- **Anything with a shell** (CI, Codex cloud, Cursor Cloud Agents, other hosted agents): give it one secret, `CONSTELLA_API_KEY`, and run the tiny CLI. It talks HTTPS, needs no install, and prints JSON:

```sh
node scripts/constella.mjs doctor                    # setup check: ok / FAIL lines for node, repo, key, api
node scripts/constella.mjs where                     # repo, branch and the ready-made handoff id
node scripts/constella.mjs recall --query "auth flow" --files src/auth.ts,src/api/users.ts
node scripts/constella.mjs add --kind decision --id auth-refresh \
  --text "Tokens refresh in src/api/auth.ts only, because two refreshers raced." --path src/api/
node scripts/constella.mjs handoff --text "Goal: ... Done: ... Next: ... Open questions: ... Branch and key files: ..."
```

`--repo owner/name` overrides the repo found by git. `--client <name>` names the tool (default `agents`). `CONSTELLA_API_URL` points it at another server.

Handoff ids look like `handoff:acme-web-app@feat-login`: `handoff:` + repo (lowercase) + `@` + branch, with every character outside letters, digits and `. _ : @ -` turned into `-`, cut to 128 characters. Every memory `id` follows the same character rule.

## Turn the hooks off

- Claude Code, only this plugin: `claude plugin disable constella@constella` (this also turns off its skills and MCP server).
- Claude Code, all hooks: add `"disableAllHooks": true` to your settings, or start one session with `claude --settings '{"disableAllHooks": true}'`. Claude Code cannot turn off one hook of a plugin by itself.
- Codex: see [codex/README.md](codex/README.md#turn-the-hooks-off).

The hooks never block the AI. On any problem (no key, no network, an error, too slow) the start hook prints a three-line reminder to call `memory_recall`, and the other hooks print nothing. The start hook gives up after 3 seconds, the edit hook after 1.5 seconds.

## Troubleshooting

Turn on the debug log and start a new session:

```sh
export CONSTELLA_DEBUG=1
```

Each hook run then adds one line to `debug.log` in the plugin's data folder: which hook, whether a key was found, the repo, the answer's status or error, how many items, and how long it took. The key and anything that looks like a token are replaced with `[key]`. Nothing goes to the AI or the terminal.

Common answers:

- `outcome: "no_key"`: no `api_key` set and no `CONSTELLA_API_KEY`.
- `status: 401`: the key is wrong or was deleted. Make a new one in **Settings > Developer**.
- `error: "timeout"`: the server took longer than the hook's time limit. The session goes on without it.
- Memory shows up for the wrong repo: check `git remote get-url origin`, or run `node scripts/constella.mjs where`.
- Not sure what is wrong: `node scripts/constella.mjs doctor` checks Node, the repo, the key and the server, one line each. It never prints the key.
- Codex, and no memory block at all: the hooks are not trusted. See [codex/README.md](codex/README.md#4-trust-the-hooks).

## For developers

```sh
npm test                      # node --test test/*.test.mjs, no network, no real key
claude plugin validate .      # checks the manifest, marketplace, hooks, skills and MCP file
```

The tests start a fake Constella API on `127.0.0.1` and run the hook the way Claude Code and Codex run it.

To check against a real server (production by default), with your own key:

```sh
CONSTELLA_API_KEY=csk_... python3 dev/live_check.py              # or --api http://127.0.0.1:8030
```

It saves a decision and a handoff as Claude Code, reads them back like a new session, lets Codex replace them,
runs the real start hook and `doctor`, then forgets everything it saved. It only uses a made-up repo
(`constella-e2e/prod-check-<time>`) and never prints the key.

License: MIT (see [LICENSE](LICENSE)).

Privacy policy: https://www.constella.app/legal/privacy-policy
