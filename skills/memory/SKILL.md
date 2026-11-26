---
name: memory
description: Constella memory, the one memory shared by all of the user's AI coding tools. Use it when starting work in a repo, when a decision, rule or lesson comes up or changes, when the user asks what was decided or what another tool did, and before stopping, pausing, switching tools, or right after a context compaction (save a handoff).
---

# Constella memory

Constella is the user's memory. Every AI tool they use (Claude Code, Codex, Cursor, ChatGPT and others) reads and writes the same memory. What you save here, the next session or another tool reads back.

## 1. The tools

Use `memory_recall` to read and `memory_add` to save. The full name depends on how Constella is connected. Use whichever one your tool list shows:

- `mcp__plugin_constella_constella__memory_recall` (this plugin)
- `mcp__constella__memory_recall` (a server named `constella`, also in Codex and Cursor)
- `mcp__constella-canvas__memory_recall` (the Constella desktop app)

The same goes for `memory_add`. If no such tool is listed but a shell is, run `node [plugin folder]/scripts/constella.mjs recall` (it needs `CONSTELLA_API_KEY`).

`repo` is always `owner/name` in lowercase, as the session-start block shows it (for example `acme/web-app`).

Every `id` you make may only use letters, digits and `. _ : @ -`, at most 128 characters. Replace any other character (such as `/` or a space) with `-`.

## 2. At the start of a task

As soon as you know the task, call:

`memory_recall(repo="owner/name", files=["the files you expect to touch"], query="the task in one line")`

Treat what comes back as standing decisions. Follow its rules. If the user's request goes against a saved rule or decision, say so and ask which one wins. Do not pick quietly.

## 3. What to save

Call `memory_add` when one of these happens, not later:

- a decision and its reason ("We use X, not Y, because Z.")
- a rule or convention for this repo
- a lesson that cost time, such as a bug's real cause or a trap
- a lasting fact that the code does not show (an outside limit, who owns a service)
- the user asks you to keep something, in any words ("make a note", "jot this down", "remember this", "add this to my Library")

There is one way to save here: `memory_add`. After saving, say only that it is saved in Constella, and that they can see it in the Constella app under **Library > Connected apps**, in this tool's folder. Do not explain a difference between a note and a memory, and do not say it is missing from their Library.

How to write it:

- One fact per memory. Full sentences that make sense alone. Say why.
- `kind`: one of `rule`, `decision`, `lesson`, `fact`, `todo`, `question`.
- `places=[{"repo": "owner/name", "path": "src/api/"}]`. Leave out `path` when it is about the whole repo.
- `id`: a short stable slug, like `auth-token-refresh`. Saving the same `id` again updates it.
- `to`: the value the session-start block shows. When unsure, `"me"`.

Example:

`memory_add(kind="decision", id="db-migrations-alembic", text="Table changes go through Alembic migrations, never startup code, because startup changes ran twice on two servers and broke a deploy.", places=[{"repo": "acme/api", "path": "db/"}], to="me")`

## 4. What not to save

- What the code or git already shows (file lists, function names, commit messages).
- Secrets: keys, tokens, passwords, `.env` values. Customer data.
- Long code. Point to the file instead.
- Status that goes stale fast ("tests pass", "server is up").
- Guesses. Save only what was decided or confirmed.

## 5. When a decision changes

Save the new one with `replaces="<id from recall>"`. This works even when another AI tool saved the old one. The old one is kept as history. Never leave an old decision standing after it changed.

## 6. When `memory_add` returns `close`

It means a saved memory says nearly the same thing.

- If yours replaces it: call `memory_add` again with the same `id` and `replaces="<its id>"`.
- If both are true: leave it.

## 7. When two memories disagree

The one with the larger `updated_at_ms` is current. Tell the user about the clash. Fix it by saving the right one with `replaces="<the other id>"`.

## 8. Handoff

Save a handoff when the user pauses, switches tool or machine, finishes a chunk of work, or right after a "context was just compacted" notice:

```
memory_add(
  kind="handoff",
  id="handoff:acme-web-app@feat-login",
  places=[{"repo": "acme/web-app"}],
  to="me",
  text="Goal: ...
Done: ...
Next: ...
Open questions: ...
Branch and key files: ..."
)
```

The id is `handoff:` + repo (lowercase) + `@` + branch, with every character outside `A-Z a-z 0-9 . _ : @ -` turned into `-`, cut to 128 characters. Example: repo `Acme/Web-App`, branch `feat/login` gives `handoff:acme-web-app@feat-login`. The session-start block prints the ready-made id; copy it. `places` keeps the real repo (`acme/web-app`).

Use exactly those five parts. If the recall showed a handoff saved by another tool, also pass `replaces="<its id>"`.

## 9. "What did X do?" or "Where are we?"

Call `memory_recall(repo="owner/name", query="the question")`. In your answer, say who saved each item (`saved_by`, `created_by`) and when (`updated_at_ms`).
