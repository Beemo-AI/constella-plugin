---
name: handoff
description: Save a Constella handoff now, so the next session or another AI tool can pick up this work. Use when the user pauses, stops, switches tool or machine, finishes a chunk of work, or after a context compaction.
---

# Save a handoff now

1. Find the repo (`owner/name`, lowercase, as the session-start block shows it) and the current branch (`git rev-parse --abbrev-ref HEAD`).

2. Build the id. The session-start block prints it ready-made; copy it if you have it. Otherwise: `handoff:` + repo (lowercase) + `@` + branch, with every character outside `A-Z a-z 0-9 . _ : @ -` turned into `-`, cut to 128 characters. Example: repo `Acme/Web-App`, branch `feat/login` gives `handoff:acme-web-app@feat-login`.

3. If this session's recall showed a handoff saved by another tool, note its id.

4. Call `memory_add` (see the `memory` skill for the tool's full name):

```
memory_add(
  kind="handoff",
  id="handoff:acme-web-app@feat-login",
  places=[{"repo": "acme/web-app"}],
  to="me",
  text="Goal: what we are trying to get done
Done: what is finished and works
Next: the very next steps, in order
Open questions: what is not decided yet, and who decides
Branch and key files: the branch, and the files that matter most"
)
```

   Use exactly those five parts, in that order. Short, plain sentences. `places` keeps the real repo (`owner/name`). If step 3 found an id, also pass `replaces="<that id>"`. For `to`, use the value the session-start block shows (usually `"me"`).

5. Show the user what was saved: the id, and the five parts.

Never put secrets, keys or long code in a handoff.
