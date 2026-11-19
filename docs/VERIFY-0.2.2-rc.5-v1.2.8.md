# VERIFY — 0.2.2-rc.5-v1.2.8

> 适配版本：harness 从 0.2.2-rc.3 升级到 0.2.2-rc.5。代码零改动，只改版本号与 engines 声明。

## 1. 变更

| 位置 | 处理 |
| --- | --- |
| `package.json` | 版本 `0.2.2-rc.3-v1.2.7` → `0.2.2-rc.5-v1.2.8`；`engines.dsh` 从 `>=0.2.2-rc.3` 提到 `>=0.2.2-rc.5`。 |

## 2. 验证

- 迁移后的 profile 在 rc.5 上完整启动，插件挂载日志齐全（权限预设就位、事件/规则/diff 三组路由注册、v3 管线挂载）。
- 真实实例（rc.5）：`/api/auto-approve/setup` 200 且 `configured:true`，patchPath 来源 `profileContext.patchPath`。
- 预设自愈：启动时 patch 已含 auto-approve 预设，日志「权限预设已就位」，无需重写。
- 代码与 v1.2.7 相同：rc.3 → rc.5 之间 host 契约（approval/request 事件、permissionPresets、agentDefaultModel、三个客户端槽位）未发现破坏性变更。
- `node --check src/index.mjs`、`node --check client.js` 通过。

## 3. 仍然未验证

- 判定模型 SAFE/RISKY 的全链路（flash-safe / flash-same）未在 rc.5 上重跑，沿用 rc.3 同代码的结论。
- 真实审批弹窗 UI 未在 rc.5 页面上逐项点击。

## 4. 说明

- 发布前隐私检查：已过（本次仅版本号与 engines 声明 + 本文档）。
