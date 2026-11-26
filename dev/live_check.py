"""Live check: save and recall through a real Constella server, as Claude Code and as Codex.

Uses the key in CONSTELLA_API_KEY (never printed), through the same door the plugin's hooks use
(POST /platform/v1/me/tools/<name>). It saves a decision and a handoff as Claude Code, reads them back the
way a new session does, lets Codex replace both (the old ones are kept as history), runs this plugin's real
start hook and `doctor`, then forgets everything it saved. Everything goes under a made-up repo
(`constella-e2e/prod-check-<time>`), so your own repos are never touched.

  CONSTELLA_API_KEY=csk_... python3 dev/live_check.py                       # production
  CONSTELLA_API_KEY=... python3 dev/live_check.py --api http://127.0.0.1:8030   # a local backend

Ends with "N/N passed" and exits 1 when any check fails. Needs Python 3.9+, git and node.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--api", default=os.environ.get("CONSTELLA_API_URL", "https://api.constella.app"))
ap.add_argument("--plugin", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                help="the plugin folder (default: the repo this script is in)")
args = ap.parse_args()
args.api = args.api.rstrip("/")

KEY = os.environ.get("CONSTELLA_API_KEY", "").strip()
if not KEY:
    sys.exit("Set CONSTELLA_API_KEY first (a key from the Constella app, Settings > Developer).")
STAMP = time.strftime("%Y%m%d%H%M%S")
REPO = f"constella-e2e/prod-check-{STAMP}"
BRANCH = "main"
HANDOFF_ID = f"handoff:constella-e2e-prod-check-{STAMP}@main"
results = []
saved = []  # (client, id) to forget at the end


def scrub(text: str) -> str:
    return str(text).replace(KEY, "[key]")


def call(tool: str, arguments: dict, client: str):
    req = urllib.request.Request(
        f"{args.api}/platform/v1/me/tools/{tool}",
        data=json.dumps({"arguments": arguments}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                 "X-Constella-Client": client, "X-Constella-Tools": "catalog"},
    )
    try:
        body = json.loads(urllib.request.urlopen(req, timeout=90).read())
        return 200, body.get("result", body)
    except urllib.error.HTTPError as e:
        return e.code, scrub(e.read().decode()[:400])


def check(name: str, ok: bool, detail: str = ""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + scrub(detail)[:300] if detail and not ok else ''}")


def recall(client: str):
    code, out = call("memory_recall", {"repo": REPO, "files": ["src/auth/login.ts"]}, client)
    return code, (out.get("sources", []) if isinstance(out, dict) else [])


# 0. The tool list has the new arguments.
req = urllib.request.Request(f"{args.api}/platform/v1/me/tools",
                             headers={"Authorization": f"Bearer {KEY}", "X-Constella-Tools": "catalog"})
try:
    tools = json.loads(urllib.request.urlopen(req, timeout=60).read())
    text = json.dumps(tools)
    check("tool list answers", True)
    check("memory_recall takes `repo` and `files`", '"repo"' in text and '"files"' in text)
    check("memory_add takes `kind`, `places`, `replaces`", all(f'"{w}"' in text for w in ("kind", "places", "replaces")))
except Exception as exc:  # noqa: BLE001
    check("tool list answers", False, str(exc))

# 1. Claude Code saves a decision pinned to a folder, and a handoff.
code, d1 = call("memory_add", {"kind": "decision", "title": "Tokens live in the keychain (prod check)",
                               "text": "Decision (prod check): login tokens live in the OS keychain, never in a file.",
                               "places": [{"repo": REPO, "path": "src/auth"}], "to": "me"}, "claude-code")
check("Claude Code saves a decision", code == 200 and isinstance(d1, dict) and d1.get("app") == "claudecode", f"{code} {d1}")
if code == 200:
    saved.append(("claude-code", d1["id"]))
code, h1 = call("memory_add", {"kind": "handoff", "id": HANDOFF_ID, "places": [{"repo": REPO}], "to": "me",
                               "text": "Goal: prod check. Done: decided tokens live in the OS keychain, never a file. Next: retry on expiry."},
                "claude-code")
check("Claude Code saves a handoff", code == 200 and isinstance(h1, dict), f"{code} {h1}")
check("the handoff gets no false 'close' hint", isinstance(h1, dict) and "close" not in h1, json.dumps(h1)[:300])
if code == 200:
    saved.append(("claude-code", HANDOFF_ID))

# 2. A new session's start-of-session recall.
t0 = time.time()
code, src = recall("claude-code")
ms = int((time.time() - t0) * 1000)
tiers = {s.get("tier") for s in src}
check(f"start recall answers ({ms} ms)", code == 200)
check("start recall has the handoff", any(s.get("tier") == "handoff" and s.get("memory_id") == HANDOFF_ID for s in src), json.dumps(src)[:300])
check("start recall has the decision, pinned to the file", any(s.get("tier") == "file" and "keychain" in (s.get("text") or "") for s in src), str(tiers))
check("each source says who saved it", all(s.get("saved_by") for s in src), json.dumps([s.get("saved_by") for s in src]))

# 3. Codex replaces Claude Code's decision (kept as history) and writes the next handoff.
old_ref = d1.get("ref") if isinstance(d1, dict) else ""
code, d2 = call("memory_add", {"kind": "decision", "title": "Keychain, encrypted file on Linux (prod check)",
                               "text": "Decision (prod check): tokens use the OS keychain; on Linux with no keychain, an encrypted file.",
                               "replaces": old_ref, "to": "me"}, "codex")
check("Codex replaces Claude Code's decision", code == 200 and isinstance(d2, dict) and d2.get("app") == "codex", f"{code} {d2}")
if code == 200:
    saved.append(("codex", d2["id"]))
handoff_ref = h1.get("ref") if isinstance(h1, dict) else ""
code, h2 = call("memory_add", {"kind": "handoff", "id": HANDOFF_ID, "replaces": handoff_ref, "to": "me",
                               "text": "Goal: prod check. Done: Linux fallback decided. Next: build the encrypted file."}, "codex")
check("Codex writes the next handoff", code == 200, f"{code} {h2}")
if code == 200:
    saved.append(("codex", HANDOFF_ID))

code, src = recall("claude-code")
texts = " | ".join(s.get("text") or "" for s in src)
check("recall now shows Codex's decision", "encrypted file" in texts, texts[:300])
check("the replaced decision is no longer shown", "never in a file" not in texts, texts[:300])
check("the handoff shown is Codex's", any(s.get("tier") == "handoff" and s.get("saved_by") == "codex" for s in src), json.dumps(src)[:300])

# 4. The plugin's real hook and doctor, in a throwaway git repo with this repo name.
hook = os.path.join(args.plugin, "scripts", "constella-hook.mjs")
cli = os.path.join(args.plugin, "scripts", "constella.mjs")
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(["git", "init", "-q", "-b", BRANCH, tmp], check=True)
    subprocess.run(["git", "-C", tmp, "remote", "add", "origin", f"https://github.com/{REPO}.git"], check=True)
    env = {**os.environ, "CONSTELLA_API_KEY": KEY, "CONSTELLA_API_URL": args.api,
           "CLAUDE_PLUGIN_DATA": os.path.join(tmp, ".plugin-data")}
    hook_in = json.dumps({"session_id": f"prod-check-{STAMP}", "cwd": tmp, "hook_event_name": "SessionStart", "source": "startup"})
    p = subprocess.run(["node", hook, "start"], input=hook_in, capture_output=True, text=True, env=env, cwd=tmp, timeout=30)
    try:
        block = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
    except Exception:  # noqa: BLE001
        block = p.stdout
    check("the plugin's start hook loads the block from production", block.startswith(f"Constella memory (repo: {REPO}"), scrub(block)[:200])
    check("the block names Codex's handoff and decision", "Last handoff (codex" in block and "encrypted file" in block, scrub(block)[:400])
    d = subprocess.run(["node", cli, "doctor"], capture_output=True, text=True, env=env, cwd=tmp, timeout=60)
    check("plugin `doctor` passes against production", d.returncode == 0, scrub(d.stdout))

# 5. Clean up: each tool forgets what it saved (forget is same-tool only).
for client, mid in saved:
    code, out = call("memory_forget", {"id": mid}, client)
    check(f"clean up {client} {mid[:40]}", code == 200 and isinstance(out, dict) and out.get("forgotten"), f"{code} {out}")
code, src = recall("claude-code")
check("nothing left for the made-up repo", code == 200 and not src, json.dumps(src)[:300])

bad = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(bad)}/{len(results)} passed. Made-up repo: {REPO}")
sys.exit(1 if bad else 0)
