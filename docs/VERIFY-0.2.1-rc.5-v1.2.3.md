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

也就是说，v1.1.2 踩过的那条「`permissionPresets.current()` 传错参数会静默降级成永远转人工」的坑，在 rc.5 上不构成新风险：签名没变。

## 3. 真机实测

### 3.1 rc.5 实例上的持续运行证据

插件在 rc.5 实例上运行正常，日常的越界升权请求被自动判定并放行（`$DSH_HOME/auto-approve/audit.log`）：

```
[2026-10-31T16:15:51.734Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T16:26:35.613Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T16:44:44.844Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T17:01:50.893Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
[2026-10-31T17:01:55.782Z] ALLOW   edit mode=danger-full-access (flash-safe)
[2026-10-31T17:01:56.553Z] ALLOW   pwsh mode=danger-full-access (flash-safe)
```

历史记录里也有硬类别转人工的样本（`HARD ... category=credential → 人工`）。

### 3.2 独立临时实例上的用例实测

环境：harness `0.2.1-rc.5` + 独立 `DSH_HOME`（不碰真实数据），profile 由真实 profile 的 `package.json` 与 `node_modules` 链接组成，加载的是 v1.2.2 的代码（与 dev 分支逐字节相同，只差 `version` 字符串）。会话权限预设切到 `auto-approve`（插件自动写入 profile 的 `cordis.patch.yml`，`GET /setup` 返回 `configured: true`、`patchPathSource: profileContext.patchPath`）。

| 用例 | 触发 | 结果 |
| --- | --- | --- |
| ① 普通升权 | 模型 `write` 到工作区外的文本文件 | 界面「自动放行 · 判定安全」；`audit.log`: `ALLOW write mode=danger-full-access (flash-safe)`；`/events`: `verdict: flash-safe, kind: auto` |
| ② 含删除语义 | 模型 `pwsh` 删除工作区外的 probe 文件 | 界面「等待审批」；`audit.log`: `HARD pwsh mode=danger-full-access category=deletion → 人工`；`/events`: `manual-pending`，人工批准后 `manual-approved` |
| ②′ 同类再来一次 | 同上的第二次尝试 | 仍然 `HARD ... category=deletion → 人工`，**没有**自动放行——硬类别不学习，符合设计 |

`learning.json` 未生成（硬类别不计数、不学习），与第 3 节的预期一致。

`node --check src/index.mjs && node --check client.js` 通过。

## 4. 仍然未验证

1. `flash-same` 命中（需要先有一个「非硬类别、判定 RISKY、人工确认」的样本）。
2. 学习沉淀（`learning.json` 的 `stats` / `history`）。
3. 设置页与审批标签页的界面点击（本轮只看请求内的提示条与审批卡片）。
4. 全新 profile 上的权限预设自举（临时 profile 的 `cordis.patch.yml` 是从真实 profile 复制的）。

## 5. 隐私检查

本轮未推送到远端；发布前按本机清单执行。
