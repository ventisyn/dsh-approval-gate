# dsh-approval-gate — Full Guide

> Home: [English](../README.en.md) · [简体中文](../README.md) · Guide: [English](GUIDE.en.md) · [中文](GUIDE.md)

DeepSeek Harness auto-approval gate plugin v0.4.0: **minimal human intervention — only operations that must be confirmed go to a human (fail-safe)**.

When a session's permission preset is `auto-approve` (Auto Approval (Flash)), every approval request (sandbox escalation) is judged through this pipeline:

```
DENY (irreversible keywords) → allowlist (deterministic rules) → denyRules (rejected upgrades) → flash (SAFE / hard categories / neutral confirmation) → learned persistence
```

- **① DENY layer**: irreversible keywords (`rm -rf`, `drop table`, `force push`, formatting, …) → human (**highest priority, fail-safe**)
- **② Allowlist layer**: a matching rule → auto-approve (deterministic, no LLM). Default rule `{mode:"workspace-write"}` — workspace writes (recoverable) auto-approve; `tool/mode/category/contains` combinations are supported (including learned rules)
- **③ denyRules layer**: `tool+mode+category` pairs the user has **explicitly rejected** → permanently human (never auto-approve what the user refused)
- **④ flash judgment** (escalations only): outputs `SAFE` or `RISKY:<category>`
  - `SAFE` → auto-approve
  - Hard-risk categories (`deletion` / `credential` / `remote` / `system` / `bulk`) → **directly human** (must confirm; no counting, no learning)
  - `neutral` (no hard-risk traits) → **confirmation mode**: first N-1 occurrences go to human, then the threshold state begins
- **⑤ Learned persistence** (neutral, N=3: confirm twice, then threshold state)
  - Before threshold: every occurrence goes to human; **approve** → count +1 and record an **operation sample** (fingerprint + context); **reject** → upgrade to denyRules
  - At threshold (count ≥ N-1), three branches:
    1. **Fingerprint hit** (this operation is in the confirmed samples) → auto-approve + persist a `{tool, mode, category, contains}` rule
    2. **No fingerprint hit but samples exist** → hand the current operation's context plus the confirmed samples to flash for **third-party similarity verification**: `SAME` (same kind as a confirmed sample) → auto-approve (persist when a fingerprint exists); `DIFFERENT` / verification failure → human
    3. **No samples** → human
  - **Reject** → upgraded to denyRules (with fingerprint; without one, block the whole kind — rejection is always strict)
  - Cancel/unavailable → not counted (no verdict from the user; next time still goes to human)
  - Hard categories / DENY / verification failures are always human; similarity verification only applies to the neutral threshold state

## Install

```sh
# Option 1: npm (recommended)
dsh plugin --profile web add dsh-approval-gate

# Option 2: GitHub
dsh plugin --profile web add "github:moon09300731/dsh-approval-gate#main"
```

## ⚠️ Manual permission preset (required after install)

The plugin cannot extend the frozen permission-preset table; add the preset manually to the profile's `cordis.patch.yml`:

Edit `~/.dsh/profiles/web/cordis.patch.yml` and append (or merge into the existing `permission` row — **the loader patch replaces the whole row's config, so restate every preset**):

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      auto-approve:
        sandbox: workspace-write
        approval: ask
        name: Auto Approval (Flash)
        description: Multi-stage judgment: workspace writes auto-approve, risky operations go to human.
```

Restart `dsh web`; the permission dropdown then offers "Auto Approval (Flash)".

## Configuration (optional)

Data files live under `$DSH_HOME/auto-approve/` (default `~/.dsh/auto-approve/`):

| File | Purpose |
|------|---------|
| `allowlist.json` | Allow/deny lists, thresholds (auto-generated on first run, old versions auto-migrate, edits take effect immediately — hot reload) |
| `learning.json` | Learning state (auto-maintained, persists across sessions) |
| `audit.log` | Audit log (append-only) |
| `events.jsonl` | Auto-approval events (for the review UI, per-session isolation) |

`allowlist.json` structure (v3):

```json
{
  "version": 3,
  "denyKeywords": ["rm -rf", "drop table", "force push", "format"],
  "allowRules": [
    { "mode": "workspace-write", "description": "Workspace writes auto-approve" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "Tool+mode+keyword rule" }
  ],
  "denyRules": [],
  "hardCategories": ["deletion", "credential", "remote", "system", "bulk"],
  "riskyThreshold": 3,
  "judgeTimeoutMs": 20000,
  "learning": { "enabled": true }
}
```

- `denyKeywords`: a hit sends the request to human (irreversible operations)
- `allowRules`: each rule matches on `tool` / `mode` / `category` / `contains` (omitted fields match anything). Learned rules are also written here
- `denyRules`: written automatically after a human rejection; a hit goes to human (no learning)
- `hardCategories`: flash `RISKY` in these categories → directly human (no counting, no learning)
- `riskyThreshold`: neutral confirmation threshold (default 3) — after N-1 human confirmations of the same tool+mode+category, the Nth occurrence auto-approves and persists a rule
- `judgeTimeoutMs`: single flash judgment timeout (default 20000ms; auto-retries once, then goes to human)

## Usage

Select **"Auto Approval (Flash)"** in the session's permission dropdown (`/permission` dialog or settings). Other sessions are unaffected (gated per session preset).

## Settings Page (v0.4.1+)

A new "Auto Approval" section in the DSH settings panel (`settings.section`) provides visual rule management:

- **Setup card**: detects whether the `auto-approve` permission preset exists in `cordis.patch.yml`; if missing, click "Configure" to write it automatically (text-level edit, comments preserved), effective after restart
- **Pipeline overview**: current judgment pipeline description + active hard-risk category badges
- **Deny list** (`denyKeywords`): view/add/remove dangerous keywords (removing a predefined keyword asks for confirmation)
- **Allow list** (`allowRules`): view (tagged predefined / learned / user) / add (tool/mode/category/contains form) / remove — e.g. add `tool=edit, mode=danger-full-access` to auto-approve all out-of-workspace edits
- **Always-human rules** (`denyRules`): view/remove (rejection-upgraded rules)
- **Learning state**: confirmation counts (`stats`) + confirmed samples (`history`)
- **Thresholds & timeout**: edit `riskyThreshold` / `judgeTimeoutMs` directly

All changes go through `POST /api/auto-approve/rules` into `allowlist.json` — **hot-reloaded immediately** (no restart); `POST /api/auto-approve/setup` handles one-click setup.

## Human Review UI (v0.4.0+)

Two review entry points appear whenever a command is auto-approved (strict DSH design language, `--dsw-alias-*` tokens):

1. **✅ Live notice strip**: a dedicated row above the composer (`conversation.input.dock`, order=30, below todo/goal/queue, does not scroll with the conversation). A green ✅ notice appears on auto-approval: tool + operation summary + verdict label (allowlist / flash-safe / learned / confirmed / flash-same), auto-dismisses after 8s, closable manually; takes zero space when idle
2. **"Approval" history view**: the tab to the right of "Trajectory" in the session view switcher (`conversation.view`, order=20). Shows the **current session's** auto-approval timeline (**newest first**): ✅ + time + tool + justification + involved-file chips + verdict badge

Data flow: the host appends a structured event to `~/.dsh/auto-approve/events.jsonl` on every auto-approval (`sessionId`/`tool`/`mode`/`reason`/`justification`/`verdict`/`files`); the browser polls `GET /api/auto-approve/events?sessionId=&since=` (2s incremental / 5s full refresh in the view).

## Security Design

1. **DENY layer highest priority**: irreversible keywords go to human with zero model calls and zero false negatives
2. **Hard-risk categories are always human**: `deletion`/`credential`/`remote`/`system`/`bulk` are never counted, learned, or covered by persisted rules
3. **Learned rules carry category + operation fingerprint**: persisted rules are `{tool, mode, category, contains}` (contains = a fingerprint you confirmed); only the same fingerprint auto-approves. When the fingerprint misses, flash does **semantic similarity verification** against your confirmed samples — DIFFERENT or verification failure always goes to human; rejected operations upgrade to denyRules (with fingerprint; without one, the whole kind is blocked), never auto-approved
4. **Fail-safe**: flash failure, timeout (20s × 2 attempts), or unparseable output → neutral degradation or human; hard risks are never auto-approved
5. **Recoverable first**: `workspace-write` (workspace writes) auto-approve by default; flash runs only for escalations
6. **Per-session gating**: only sessions that explicitly selected the "Auto Approval (Flash)" preset are intercepted
7. **Judge only, never execute**: the plugin returns an allow/forward decision; it does not modify the rest of the approval flow

> Warning: auto-approval dramatically lowers human intervention. **Trusted environments only** — keep the `ask` preset for production data, remote systems, payments, and other high-risk scenarios.

## Technical Notes

- Mounted at the front of the `approval/request` waterfall (`prepend: true`, before the web answerer)
- Gate: `permissionPresets.current(session.events) === 'auto-approve'`
- DSH approval fires on sandbox escalation; `reason` is always `escalate sandbox to <mode>: <justification>`, with `mode` in `workspace-write` / `danger-full-access`
- flash judgment: `reasoningEffort: 'off'` + `maxTokens: 64`, outputs `SAFE` or `RISKY:<category>`
- Timeout: `AbortController` signal into `llm.stream` (cancellable), `Promise.race` + `ctx.timeout(judgeTimeoutMs)`, abort + one retry
- Similarity verification: current operation context + confirmed samples to flash (`SAME`/`DIFFERENT`); failure counts as DIFFERENT
- Learning loop: captures human verdicts through the waterfall `next()` return (`allowed-once` persists / `rejected` upgrades)
- Review UI: host writes `events.jsonl` + `GET /api/auto-approve/events` (sessionId filter + since cursor); client polls and renders

## License

MIT
