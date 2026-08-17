[简体中文](README.md) | **English**

# dsh-approval-gate

**Auto-approval gate for DeepSeek Harness — minimal human intervention: safe operations auto-approve, risky ones go to a human (fail-safe).**

A Flash model pre-judges every sandbox escalation: routine operations auto-approve, hard-risk operations (deletion / credentials / remote / system / bulk) always require human confirmation; learned rules only ever cover operations you confirmed, with an in-app human review UI.

## ✨ Features

- ⚡ **Flash risk pre-judgment**: every sandbox escalation is judged by a Flash model (`SAFE` / `RISKY:<category>`); recoverable operations auto-approve
- 🛡️ **Hard risks are always human**: deletion, credentials, remote/production, system paths, and bulk irreversible operations go directly to human — no counting, no learning
- 🎯 **Confirmation-based learning**: after N-1 human confirmations of the same operation, it auto-approves; persisted rules carry an **operation fingerprint**, so only operations you confirmed are auto-approved
- 🧠 **Semantic similarity verification**: operations with different wording but the same intent are judged by Flash against your confirmed samples — no keyword dependency
- 🔧 **Hot-reloadable config**: `allowlist.json` edits take effect immediately, no restart
- ✅ **Human review UI**: a green notice appears above the composer on auto-approval; the "Approval" view (right of Trajectory) shows the current session's full auto-approval timeline

## 📸 Screenshots

Auto-approval notice (in conversation) | Approval history view
:---:|:---:
![Auto-approval notice](docs/screenshots/approval-notice.png) | ![Approval history view](docs/screenshots/approval-history.png)

## 🚀 Quick Start

```sh
dsh plugin --profile web add dsh-approval-gate
```

1. **Add the permission preset**: append the `auto-approve` preset to `~/.dsh/profiles/web/cordis.patch.yml` ([see guide](docs/GUIDE.en.md#%E2%9A%A0%EF%B8%8F-manual-permission-preset-required-after-install))
2. **Restart** `dsh web`
3. **Select the preset**: choose "Auto Approval (Flash)" in the session's permission dropdown

## 📖 Docs

- [Full Guide (pipeline / configuration / security / review UI)](docs/GUIDE.en.md) · [中文指南](docs/GUIDE.md)

## 📄 License

MIT
