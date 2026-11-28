# Constella Memory for OpenCode v2

Shared workspace + private personal memory for **OpenCode v2** (`@opencode/plugin`). Works for both coding teams (with a git repo) and non-coding teams (recruiting, ops, support — no repo required).

## What it does

- **Session start (prompt-cache safe):** On the first turn of a session, calls `memory_recall(mode="start")` once, formats the last handoff, active rules, pinned context, and a compact memory index, and injects that exact same static block on subsequent turns so provider prompt caches stay warm.
- **On-demand tools (`ctx.tool.transform`):**
  - `constella_recall` — search across personal + workspace memory (`scope`: `"all"`, `"me"`, or `"workspace"`).
  - `constella_fetch` — read the full text of any compact index hit by `id`.
  - `constella_save` — save a durable rule, decision, preference, lesson, fact, or handoff (`scope="me"` default; `scope="workspace"` only when intentionally sharing with the team). Stamps `agent: "opencode"`, `session_id`, and code or non-code `places`.
  - `constella_upload_session` — scrub and upload the current session transcript to the member's private box on demand.
- **Private transcript ingest (`uploadMode`):**
  - `"end"` *(default, recommended)*: uploads the **full scrubbed transcript once** when the session closes (`session.deleted` / `session.closed`). Produces the cleanest extraction and contradiction resolution because Constella's Brain sees the full conversation arc.
  - `"incremental"`: for multi-hour sessions, uploads **only new turns** on `session.idle` using `chunk_seq: 1, 2, ...` so no turn is ever re-sent or double-billed.
  - `"manual"`: only uploads when `constella_upload_session` is called.
  - Raw transcripts **always** go to `/platform/v1/users/{uid}/ingest` (the member's private box) — never auto-shared to a workspace.

## Quick setup (solo / personal OpenCode v2 — 1 step)

Run one command (or paste it into OpenCode):

```sh
npx -y github:Beemo-AI/constella-plugin setup
```

It signs you in once in the browser, saves your personal key (`csk_...`) to `~/.constella/credentials.json` (mode `600`), installs the OpenCode plugin locally into `~/.constella/opencode-plugin`, and registers it in `~/.config/opencode/opencode.json` (no API key is written into OpenCode's settings). Use `--only opencode` to configure OpenCode alone.

---

## Quick setup (self-hosted OpenCode v2 for teams)

### 1. Provision workspace & member on your backend (once)

Using your server-side `cak_live_` Platform app key:

```sh
# Create a workspace (enables Brain-based shared memory)
curl -X PUT https://api.constella.app/platform/v1/workspaces/ws_recruiting \
  -H "Authorization: Bearer $CONSTELLA_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Recruiting","extraction_instructions":"Never extract personal opinions or bias."}'

# Add a member (provisions account and enables Brain-based memory)
curl -X PUT https://api.constella.app/platform/v1/workspaces/ws_recruiting/members/user_alice \
  -H "Authorization: Bearer $CONSTELLA_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

### 2. Mint a scoped single-user `cps_` session token when launching OpenCode

Never place your master `cak_live_` app key inside an OpenCode session. Mint a short-lived `cps_` token scoped strictly to `user_alice`:

```sh
curl -X POST https://api.constella.app/platform/v1/users/user_alice/session-token \
  -H "Authorization: Bearer $CONSTELLA_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttl_seconds":28800}'
```

Pass the returned token into the OpenCode container environment:

```sh
export CONSTELLA_SESSION_TOKEN="cps_..."
export CONSTELLA_USER_ID="user_alice"
export CONSTELLA_WORKSPACE_ID="ws_recruiting"
```

### 3. Register the plugin in `opencode.jsonc`

See [`opencode.jsonc.example`](./opencode.jsonc.example) for a full config template.

### 4. Optional: add a custom `beforeUpload` PII scrubber

Wrap `createConstellaPlugin` in `.opencode/plugins/constella.ts`:

```ts
import { Plugin } from "@opencode/plugin";
import { createConstellaPlugin } from "@constella/opencode-plugin";

export default Plugin.define(
  createConstellaPlugin({
    recallMode: "hybrid",   // "hybrid" | "tools" | "every_turn"
    uploadMode: "end",      // "end" (recommended) | "incremental" | "manual"
    beforeUpload: async (payload) => {
      // Run your org's PII/secret scrubber before anything leaves OpenCode.
      // Return `null` to skip uploading a sensitive session completely.
      return {
        ...payload,
        messages: payload.messages.map((m) => ({
          ...m,
          content: m.content.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]"),
        })),
      };
    },
  })
);
```

## Configuration reference

| Option | Env variable | Default | Description |
|---|---|---|---|
| `token` | `CONSTELLA_SESSION_TOKEN` / `CONSTELLA_API_KEY` | `""` | Scoped `cps_` session token (Platform mode) or `csk_` key (personal mode). |
| `userId` | `CONSTELLA_USER_ID` | `""` | External user id (`uid`) for Platform workspace & ingest routes. |
| `workspaceId` | `CONSTELLA_WORKSPACE_ID` | `""` | Active workspace id (`ws_...`) for `scope: "workspace"` saves/recalls. |
| `apiUrl` | `CONSTELLA_API_URL` | `https://api.constella.app` | Constella API base URL. |
| `agent` | `CONSTELLA_AGENT` | `"opencode"` | Agent name recorded in actor provenance & `X-Constella-Client`. |
| `recallMode` | `CONSTELLA_RECALL_MODE` | `"hybrid"` | `"hybrid"`, `"tools"`, or `"every_turn"`. |
| `uploadMode` | `CONSTELLA_UPLOAD_MODE` | `"end"` | `"end"` (full transcript at close), `"incremental"` (`chunk_seq` on idle), or `"manual"`. |
| `places` | `CONSTELLA_DEFAULT_PLACES` (JSON) | `[]` | Default non-code or code places attached to recall, saves, and ingests. |
| `beforeUpload` | — *(JS/TS only)* | `null` | Async `(payload) => scrubbedPayload \| null` scrubber hook. |
| `fileRecall` | — | `true` | Surface folder memories before first edit in git repos. |
