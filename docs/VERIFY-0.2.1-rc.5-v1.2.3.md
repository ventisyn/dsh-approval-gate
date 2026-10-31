# VERIFY — 0.2.1-rc.5-v1.2.3

> 这一版把插件接到 harness `0.2.1-rc.5` 版本线上。插件代码与 v1.2.2 完全相同，只改版本号；适配结论是**不需要改代码**。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| package.json | `version` 从 `0.2.1-alpha.2-v1.2.2` 提到 `0.2.1-rc.5-v1.2.3` |
| 分支 | 新开 `0.2.1-rc.5-v1.2.3/dev`，验收后改名发布 |
| 代码 | 无变更（`src/index.mjs`、`client.js`、`cordis.patch.yml` 与 v1.2.2 相同） |

## 2. 公开 API 侦察（alpha.2 → rc.5）

| 依赖面 | rc.5 状态 |
| --- | --- |
| `permissionPresets.current(session: Session): string` | 签名未变（`dsh-permission-presets` 的类型定义） |
| `ctx.on('approval/request')` | 事件仍在（`dsh-user-approval` 代码无变化） |
| `agentDefaultModel.currentSelection(): ModelSelection` | 仍在（`dsh-agent-default-model`） |
| `profileContext.patchPath` / `.dir` | rc.5 可用；`GET /api/auto-approve/setup` 返回 `patchPathSource: profileContext.patchPath` |
| 客户端槽位 `conversation.input.dock` / `conversation.view` / `settings.section` | 三个都还在 |

也就是说，v1.2.2 踩过的那条「`permissionPresets.current()` 传错参数会静默降级成永远转人工」的坑，在 rc.5 上不构成新风险：签名没变。

## 3. 真机证据（rc.5 实例，运行中的 v1.2.2）

插件在 rc.5 实例上运行正常，本次工作期间的越界升权请求被自动判定并放行（`$DSH_HOME/auto-approve/audit.log`）：

```
[2026-10-31T16:15:51.734Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T16:26:35.613Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T16:44:44.844Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T17:01:50.893Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T17:01:55.782Z] ALLOW   edit mode=danger-full-access (flash-safe)
[2026-10-31T17:01:56.553Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
```

- `GET /api/auto-approve/events` 有对应条目（`verdict: flash-safe`、`kind: auto`），共 1494 条历史。
- 历史记录里也有硬类别转人工的样本：`HARD ... category=credential → 人工`。
- `node --check src/index.mjs && node --check client.js` 通过。

## 4. 仍然未验证

1. 含删除语义的请求转人工——本版没有主动构造（历史 audit 有硬类别样本，但不是在 v1.2.3 上复验的）。
2. `flash-same` 命中（需要先人工确认一次同类操作，再触发第二次）。
3. 学习沉淀（`learning.json` 的 `stats` / `history`）。
4. 设置页与审批标签页的界面点击。
5. 全新 profile 上的权限预设自举（本机 profile 早已配置好）。

## 5. 隐私检查

本轮未推送到远端；发布前按本机清单执行。
