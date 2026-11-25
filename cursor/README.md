# Constella memory in Cursor

Cursor gets the MCP server and the skills. It does not use this plugin's hooks, so the AI calls `memory_recall` itself at the start of a task (the `memory` skill tells it to).

Not run in Cursor here. Everything below is from Cursor's docs (https://cursor.com/docs/mcp.md and https://cursor.com/docs/skills.md), read on 2026-11-24.

## 1. The MCP server

Add this to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project). The same block is in `cursor/mcp.json` next to this file.

```json
{
  "mcpServers": {
    "constella": {
      "url": "https://api.constella.app/mcp",
      "headers": {
        "X-Constella-Client": "cursor"
      }
    }
  }
}
```

Cursor then signs you in to Constella in the browser (OAuth). Nothing else is needed.

To use a key instead of a sign-in, make one in the Constella desktop app (**Settings > Developer**), put it in your environment as `CONSTELLA_API_KEY`, and add two headers. Cursor fills in `${env:NAME}` in `url` and `headers`:

```json
{
  "mcpServers": {
    "constella": {
      "url": "https://api.constella.app/mcp",
      "headers": {
        "Authorization": "Bearer ${env:CONSTELLA_API_KEY}",
        "X-Constella-Client": "cursor",
        "X-Constella-Tools": "catalog"
      }
    }
  }
}
```

`X-Constella-Tools: catalog` asks for the current tool names (`memory_recall`, `memory_add`). A browser sign-in gets them without it.

Or let a tool write the entry for you (not run here): `npx add-mcp https://api.constella.app/mcp -a cursor -n constella`.

## 2. The skills

Copy the three folders in `skills/` (`memory`, `init`, `handoff`) into one of these:

- `~/.cursor/skills/` (every project, this machine)
- `.cursor/skills/` or `.agents/skills/` in the repo (one project)

Each folder keeps its name, because a skill's `name` must match its folder. Or use `npx skills add Beemo-AI/constella-plugin -a cursor` (see the main README; not run here).

Type `/memory`, `/init` or `/handoff` in Agent chat to run one. `init` has `disable-model-invocation: true`, so Cursor only runs it when you ask.

Cursor also reads skills from `~/.claude/skills/` and `~/.codex/skills/`. If you already copied these skills there, do not copy them again, or Cursor sees two of each.

## 3. Tools that do not load skills

Paste `AGENTS.snippet.md` into the repo's `AGENTS.md` or a Cursor rule instead.

## Cloud Agents

Cursor's hosted Cloud Agents do not read `~/.cursor/mcp.json`. Add the server at https://cursor.com/agents instead, or give the agent `CONSTELLA_API_KEY` as a secret and let it run `node scripts/constella.mjs recall` (see the main README).
