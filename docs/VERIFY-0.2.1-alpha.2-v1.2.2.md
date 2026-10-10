# 0.2.1-alpha.2-v1.2.2 验收记录

验收日期：2026-10-10。本轮为文档改动（版本号 + `AGENTS.md` 约定），插件代码与上一版逐行一致，因此验收重点是**在 `0.2.1-alpha.2` 这个新 harness 上确认门控真的接管**，而不是只看加载日志。

## 环境

- harness：`0.2.1-alpha.2`（profile 同名，端口以实例实际启动参数为准）。
- 启用形态：`allowlist.json` 三态中的默认态（判定模型钉死，来源见 `/api/auto-approve/rules` 的 `judge` 字段）。
- 会话权限预设：`auto-approve`，由插件启动时写入 profile 的 `cordis.patch.yml`（`configured: true`，`patchPathSource = profileContext.patchPath`）。

## 结果

| 自检项 | 结果 |
| --- | --- |
| `node --check src/index.mjs && node --check client.js` | 通过 |
| 实例内已装副本与本轮代码同源 | 通过（`git diff --no-index` 无差异，仅 CRLF/LF 告警） |
| 重启后越界请求被接管（第 9 节第 2、3 项） | 通过：`/api/auto-approve/events` 非空，`audit.log` 新增决策 |
| 普通升权 → 自动放行 | 通过：`ALLOW ... (flash-safe)` |
| 含删除语义 → 转人工 | 通过：`HARD ... category=deletion → 人工`，界面出现审批条目，人工批准后动作放行，事件终态 `manual-approved` |
| 硬类别不计数、不学习 | 通过：该次人工确认后 `learning.json` 未写入，`audit.log` 无 `LEARN` 行 |
| 预设自举与路径解析（第 4 节） | 通过：profile 的 `cordis.patch.yml` 预设块形态合法，无空序列根导致的启动失败 |
| 客户端注册 | 通过：`conversation.input.dock`(30)、`conversation.view`(20)、`settings.section`(60) 三个槽位注册与规范一致 |

未覆盖：`flash-same` 用例与 `learning.json` 计数增长需要「常规操作 + 人工确认」样本，本轮没有该样本，留待下一次实测。

## 隐私检查

隐私检查：已过（按本机清单逐条核对当轮新增字节，含提交信息与文档；截图本轮无新增）。
