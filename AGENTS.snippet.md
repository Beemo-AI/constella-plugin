<!-- Paste this block into AGENTS.md (or CLAUDE.md, .cursor/rules, or any agent rules file) for AI tools that do not load skills. -->

## Constella memory (shared by all of this user's AI tools)

The tools are `memory_recall` and `memory_add` (any prefix: `mcp__constella__`, `mcp__plugin_constella_constella__`, `mcp__constella-canvas__`). `repo` is `owner/name` in lowercase, from the `origin` remote (for example `acme/web-app`).

- **Start of a task:** call `memory_recall(repo="owner/name", files=[files you expect to touch], query="the task in one line")`. Treat the result as standing decisions and follow its rules. If the request goes against one, say so and ask.
- **Save** with `memory_add` when a decision (with its reason), a rule or convention, a costly lesson (a bug's real cause) or a lasting fact the code does not show comes up. One fact per memory, full sentences, say why. `kind` is one of `rule`, `decision`, `lesson`, `fact`, `todo`, `question`. `places=[{"repo": "owner/name", "path": "src/x/"}]` (leave out `path` for the whole repo). `id` is a short stable slug using only letters, digits and `. _ : @ -` (at most 128 characters). `to="me"` unless told otherwise.
- **Anything the user asks you to keep** ("make a note", "jot this down", "remember this") is also a `memory_add`: it is the one way to save. Then say only that it is saved in Constella (Constella app: Library > Connected apps, this tool's folder). Do not explain notes versus memory.
- **Do not save** what code or git shows, secrets or customer data, long code, short-lived status, or guesses.
- **A decision changed:** save the new one with `replaces="<old id from recall>"`. It works across AI tools and keeps the old one as history.
- **`memory_add` returned `close`:** if yours replaces it, save again with the same `id` and `replaces="<its id>"`. If both are true, leave it.
- **Two memories disagree:** the larger `updated_at_ms` is current. Tell the user, and fix it with `replaces`.
- **Handoff** when the user pauses, switches tool or machine, finishes a chunk, or after a context compaction: `memory_add(kind="handoff", id="handoff:acme-web-app@feat-login", places=[{"repo": "acme/web-app"}], text="Goal: ... Done: ... Next: ... Open questions: ... Branch and key files: ...")`. The id is `handoff:` + repo (lowercase) + `@` + branch, every character outside `A-Za-z0-9._:@-` turned into `-`, cut to 128 (repo `Acme/Web-App`, branch `feat/login` gives `handoff:acme-web-app@feat-login`). `places` keeps the real repo. If recall showed another tool's handoff, pass `replaces="<its id>"`.
- **"What did X do?" / "Where are we?":** `memory_recall(repo="owner/name", query="...")`, and say who saved each item (`saved_by`, `created_by`) and when.
