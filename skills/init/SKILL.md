---
name: init
description: Set up Constella memory for this repo. First checks that the setup works (in Codex it walks the user through sign-in, the key, trusting the hooks and the permission choice, one step at a time). Then finds the rules and decisions already written down in the repo's docs, shows them to the user, and saves only the ones the user keeps.
disable-model-invocation: true
---

# Set up Constella memory for this repo

There are two parts. Part 1 checks that memory works. Part 2 seeds memory from the repo.

Use the `memory_recall` and `memory_add` tools (see the `memory` skill for their names). `repo` is `owner/name` in lowercase, as the session-start block shows it.

## Part 1: check the setup

Look at the start of this session for a block from Constella.

- It starts with `Constella memory (repo: ...`: the hooks run and the key works. Call `memory_recall(repo="owner/name")` once. If it answers, tell the user "Setup is good" in one line and go to Part 2.
- Anything else, and you are **not** in Codex: call `memory_recall(repo="owner/name")`. If it answers, go to Part 2. If it fails, tell the user to sign in to Constella (see the plugin's `README.md`), and stop.
- Anything else, and you **are** in Codex (you are the Codex agent; you edit files with `apply_patch`): do the Codex walk-through below.

### Codex walk-through

Rules for the whole walk-through:

- One step at a time. Check the step yourself first. Only talk to the user about a step that is not done. After each fix, wait for the user to say it is done, then check again.
- Never print, ask for, or read the value of `CONSTELLA_API_KEY`. Never open `~/.codex/auth.json`. Never edit `~/.codex/config.toml` or `~/.codex/hooks.json` yourself. Show the user the lines and let them do it.
- You cannot trust hooks and you must not change the permission mode. Only the user can. Tell them what to type.
- Use short, plain sentences. Full details for every step are in `codex/README.md` in the plugin folder. The plugin folder is two levels above this file.

**Step 1. Sign-in (the tools).** Call `memory_recall(repo="owner/name")`.
- It answers: done.
- No such tool: the plugin's MCP server is missing. Ask the user to run `codex plugin add constella@constella` in a terminal, start a new session, and run this skill again. Stop.
- It fails or asks for a sign-in: ask the user to run `codex mcp login constella` in a terminal, sign in in the browser, and tell you when done. Then call it again.

**Step 2. The key (for the hooks).** Run `node "[plugin folder]/scripts/constella.mjs" doctor --client codex` from the repo. It prints `ok`, `FAIL` or `skip` lines for `node`, `repo`, `key` and `api`. It never prints the key.
- All `ok`: done.
- `FAIL key`, or `FAIL api ... could not be reached`: your own shell may be the cause, not the user's setup. Codex can hide variables from your commands, and the sandbox can block the network. Ask the user to run the same command in their own terminal and tell you only the first word of each line.
- The user's run also says `FAIL key`: tell them to make a key in the Constella desktop app (**Settings > Developer**), add `export CONSTELLA_API_KEY="csk_..."` to their shell profile, and open a new terminal. They must not paste the key into this chat.
- `FAIL api ... did not accept the key`: the key is wrong or deleted. They need a new one.
- The user does not want a key: that is fine. Say that memory then loads only when you call `memory_recall`, and go on.

**Step 3. Trust the hooks.** You already know the answer from the start of this session:
- A block starting with `Constella memory (repo: ...` or `Constella memory is connected for this repo`: the hooks run. Done.
- No block: the hooks are not trusted yet. Codex skips them without a word. Tell the user: "Type `/hooks` and trust the Constella hooks. In the Codex desktop app, click **Review hooks** in the composer or open **Settings > Hooks**. I cannot do this for you. After a plugin update you must trust them again."
- You cannot see the result in this session, because the start hook only runs when a session starts. Say so.

**Step 4. The permission choice (optional).** Ask the user if they want Codex to stop and ask less often. If yes, explain the three choices in a few lines and let them pick:
- **Ask for approval** (the normal way): Codex works in the project folder and asks before going outside it.
- **Middle:** stay in the project folder, and a reviewer AI answers the questions. CLI: `codex --approve-for-me`. Desktop app: **Approve for me**.
- **Full access:** no sandbox and no questions, like Claude Code's `--dangerously-skip-permissions`. CLI: `codex --dangerously-bypass-approvals-and-sandbox` (short `--yolo`). Desktop app: **Full access** in the permissions control below the composer. In a running session: `/permissions`.

Always say the risk in one sentence: with full access Codex can run any command, change or delete any file, and use the network without asking. Then only give the command for the choice they made. Do not switch the mode yourself, do not suggest full access first, and do not write it into their config. If they want it to stick, point them to step 5 of `codex/README.md`.

Also offer the two config lines from `codex/README.md` that let `memory_recall` and `memory_add` run without a question each time. The user adds them.

**Step 5. Check it works.** Tell the user what to do next, since it needs a new session:
1. Start a new Codex session in this repo.
2. Ask: "What does your Constella memory block say? Show its first line."
3. They should see a line starting with `Constella memory (repo: owner/name, branch: ...)`.

If they see `Constella memory is connected for this repo ... not loaded automatically`, the key did not reach the hooks: Codex was started from a terminal that does not have it. If they see nothing, the hooks are still not trusted. More cases are in "If it does not work" in `codex/README.md`.

End with a short list: each step and `done`, `skipped` or `waiting on you`. Then ask if they want Part 2 now. Part 2 only needs Step 1 to be done.

## Part 2: seed memory from the repo

Do these steps in order.

1. Read what the repo already says about how it works:
   - `CLAUDE.md` and `AGENTS.md` (in the root and in sub-folders)
   - `README.md`
   - decision files under `docs/`: names with `decision`, `adr`, `architecture`, `conventions` or `rules`
   - `git log -30 --oneline`

2. Call `memory_recall(repo="owner/name")` to see what is already saved. Do not suggest those again.

3. Draft at most 15 candidates. Each one is:
   - one rule, decision, lesson or fact, in one or two full sentences, with the why
   - a `kind` (`rule`, `decision`, `lesson` or `fact`)
   - the folder it is about, if it is about one folder (`path`)

   Pick what a new teammate, or another AI tool, would get wrong without being told. Skip what the code itself makes obvious.

4. SHOW the numbered list to the user. Ask which ones to keep. Wait for the answer.

5. Save only the ones the user kept, one `memory_add` each:

   `memory_add(kind="rule", id="init:[short-slug]", text="...", places=[{"repo": "owner/name", "path": "src/api/"}], to="me")`

   Leave out `path` when it is about the whole repo. Ids start with `init:`. An id may only use letters, digits and `. _ : @ -` (at most 128 characters), so write the slug like `init:migrations-only`.

6. Tell the user how many were saved.

Never upload whole files or long passages. Save short sentences only. Never save secrets.
