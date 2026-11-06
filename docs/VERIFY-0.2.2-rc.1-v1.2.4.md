# VERIFY — 0.2.2-rc.1-v1.2.4

> 这一版把插件接到 harness `0.2.2-rc.1` 版本线上。插件业务代码与 v1.2.3 完全相同；唯一的代码性改动是
> `package.json` 增加 `engines.dsh` 兼容声明（0.2.2 起宿主会检查它）。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| package.json | `version` 从 `0.2.1-rc.5-v1.2.3` 提到 `0.2.2-rc.1-v1.2.4`；`engines` 增加 `"dsh": ">=0.2.2-rc.1"` |
| 分支 | 新开 `0.2.2-rc.1-v1.2.4/dev`，验收后改名发布 |
| 代码 | 无变更（`src/index.mjs`、`client.js`、`cordis.patch.yml` 与 v1.2.3 相同） |
| AGENTS.md | 第 11 节版本号示例更新 |

## 2. 公开 API 侦察（0.2.1-rc.5 → 0.2.2-rc.1）

对两版全部 `@deepseek-ai` 包做文件级哈希对比 + 差异文件逐行 diff，结论：

- **本插件依赖的契约未变**：`permissionPresets.current(session)` 方法体逐字相同；`approval/request` 瀑布调用逐字相同；
  `agentDefaultModel.currentSelection()` 所在包逐字节相同；客户端 `window.__ModuleLoader__.load` 形状、
  `require` 注入、本插件用到的槽位（`conversation.input.dock` / `conversation.view` / `settings.section`）与 owner props 均未变。
- **新版变化（不影响本插件）**：`dsh-user-approval` 内部改为从 `approvalState` 投影取 turnOpen（行为等价）；
  `dsh-permission-presets` 的投影状态从 `session-projection/types` 迁到 `session/types`（本插件只调用 `current()`）；
  侧栏会话菜单迁到新的 context-menu 机制（本插件不注册该槽位）。
- **新增插件兼容性检查**：0.2.2 的 `dsh plugin` 读插件 `package.json` 顶层 `engines.dsh`（或 `@deepseek-ai/dsh-*` peerDeps），
  不满足时拒绝安装并要求 `dsh plugin allow-version`；本版因此显式声明 `engines.dsh`。

## 3. 怎么测的

**离线**：`node --check src/index.mjs`、`node --check client.js` 通过。

**真机（隔离实例，独立 `DSH_HOME`，被测包为 dev 工作副本复制进 profile 的 `node_modules`）**：

| 验证项 | 结果 |
| --- | --- |
| 插件加载 | 启动时自动写入 `auto-approve` 权限预设（status=added-entry）；重启后日志「权限预设已就位」；三条 API 200 |
| 预设与判定模型 | `GET /setup` 返回 `configured: true`；`GET /rules` 的 `judge` = deepseek-official/deepseek-flash（source=cordis.patch.yml，钉死生效） |
| 自动放行 | 工作区外写入的升权请求 → `verdict: flash-safe`；audit.log 记录 `ALLOW ... (flash-safe)`；events 非空 |
| 中立计数 | 同类请求再次出现 → `category=neutral confirm=1/3 → 人工`；事件 `manual-pending`，界面出现「等待审批」 |
| 人工确认 + 学习 | 点「允许一次」→ audit.log `OUTCOME ... outcome=allowed-once`；`learning.json` 写入 `stats` 与 `history` 样本 |
| 人工拒绝 + 学习 | 点「拒绝」→ audit.log `OUTCOME ... outcome=rejected` + `LEARN ... 被人工拒绝，已升级永久人工` |
| 客户端 UI | 「等待审批」提示条与「审批」标签页正常出现，「允许一次 / 拒绝」按钮可用 |

## 4. 仍然未验证

1. **硬类别**（`deletion` / `credential` / `remote` / `system` / `bulk`）在 0.2.2-rc.1 上的转人工行为：本轮会话里的 agent
   拒绝执行 `rm -rf` 这类测试命令（引用了仓库红线），没有产生可测的 deletion 升权请求；该层逻辑未随 harness 版本变化，
   沿用 v1.2.3 的实测结论（deletion / system 均转人工）。
2. `flash-same` 与 `allowRules` 命中路径：同 v1.2.3 的结论——判定模型对同类请求输出不稳定，本轮 learning 计数只累积到 1/3。
3. 客户端 UI 的逐项交互（提示条点击、审批标签页详情、设置页判定模型下拉）未逐项点击。

## 5. 隐私检查

已过（0 处待办）。
