# dsh-approval-gate

DeepSeek Harness 自动审批门控插件 v3：**最小人工介入，只把必须人工确认的操作转人工（fail-safe）**。

当会话的权限预设为 `auto-approve`（自动审批（Flash））时，每次审批请求（沙箱越界）按管道判定：

```
DENY（不可逆危险词）→ 白名单（确定性规则）→ denyRules（裁决拒绝升级）→ flash（SAFE / 硬类别 / 中立计数）→ 裁决学习
```

- **① DENY 层**：`rm -rf` / `drop table` / `force push` / 格式化等不可逆危险词命中 → 转人工（**最高优先，fail-safe**）
- **② 白名单层**：命中规则 → 直接放行（确定性，不过 LLM）。默认规则 `{mode:"workspace-write"}` —— 工作区写入（可回补）自动放行；也支持 `tool/mode/category/contains` 组合规则（含学习沉淀的规则）
- **③ denyRules 层**：此前用户**裁决拒绝**过的「工具+模式+类别」→ 永久转人工（不会自动放行用户明确拒绝过的操作）
- **④ flash 判定**（仅越界请求）：输出 `SAFE` 或 `RISKY:<category>`
  - `SAFE` → 自动放行
  - 硬风险类别（`deletion` 删除 / `credential` 凭据 / `remote` 远程生产 / `system` 系统路径 / `bulk` 批量不可回补）→ **直接转人工**（必须人工确认，不计数、不学习）
  - `neutral`（中立，无硬风险特征）→ **计数放行**：前 N-1 次直接放行（audit 记录），第 N 次转人工裁决
- **⑤ 裁决学习**：中立类别第 N 次转人工后
  - 用户**批准** → 沉淀为自动放行规则 `{tool, mode, category}`（以后同类直接放行，不过 flash）
  - 用户**拒绝** → 升级进 denyRules（以后同类直接转人工）
  - 取消/不可用 → 保留计数，下次继续转人工

## 安装

```sh
# 方式一：npm 安装（推荐）
dsh plugin --profile web add dsh-approval-gate

# 方式二：GitHub 安装
dsh plugin --profile web add "github:moon09300731/dsh-approval-gate#main"
```

## ⚠️ 安装后必须手动配置权限预设（关键步骤）

插件无法向权限预设表添加选项（预设表在配置构造时冻结），需要手动在 profile 的 `cordis.patch.yml` 中补一条 preset：

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加（或合并进已有的 `permission` 行——**loader 的 patch 会整体替换目标行的 config，若已有该行必须重述全部预设**）：

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
        name: 自动审批（Flash）
        description: 多级判定：工作区写入自动放行，危险操作转人工审批。
```

重启 `dsh web` 后，权限下拉菜单会出现「自动审批（Flash）」选项。

## 配置（可选）

数据文件统一放在 `$DSH_HOME/auto-approve/`（默认 `~/.dsh/auto-approve/`）：

| 文件 | 说明 |
|------|------|
| `allowlist.json` | 白名单/黑名单/阈值配置（首次运行自动生成默认值，旧版自动迁移） |
| `learning.json` | 学习状态（自动维护，跨会话持久化） |
| `audit.log` | 审计日志（追加式） |

`allowlist.json` 结构（v3）：

```json
{
  "version": 3,
  "denyKeywords": ["rm -rf", "drop table", "force push", "格式化"],
  "allowRules": [
    { "mode": "workspace-write", "description": "工作区写入自动放行" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "特定工具+模式+关键词" }
  ],
  "denyRules": [],
  "hardCategories": ["deletion", "credential", "remote", "system", "bulk"],
  "riskyThreshold": 3,
  "judgeTimeoutMs": 20000,
  "learning": { "enabled": true }
}
```

- `denyKeywords`：命中即转人工（不可逆危险操作）
- `allowRules`：每条规则 `tool` / `mode` / `category` / `contains` 均满足才放行（缺省表示任意）。学习沉淀的规则也会写入这里
- `denyRules`：用户裁决拒绝后自动写入，命中即转人工（不学习）
- `hardCategories`：flash 判 RISKY 且命中这些类别 → 直接转人工（不计数、不学习）
- `riskyThreshold`：中立类别被判 RISKY 的计数阈值，达到后转人工裁决（默认 3）
- `judgeTimeoutMs`：单次 flash 判断超时（默认 20000ms，超时自动重试 1 次，仍超时转人工）

## 使用

在会话的权限下拉（`/permission` 弹窗或设置页）选中**「自动审批（Flash）」**，该会话即启用自动审批；其他会话不受影响（按会话预设门控）。

## 安全设计

1. **DENY 层最高优先**：不可逆危险词命中即转人工，不消耗模型调用、无误判
2. **硬风险类别永远人工**：`deletion`/`credential`/`remote`/`system`/`bulk` 不计数、不学习、不可被沉淀规则覆盖
3. **学习规则始终带类别**：沉淀的是 `{tool, mode, category}`，不会产生裸 `{tool}` 宽规则；拒绝过的操作升级 denyRules，永不自动放行
4. **fail-safe**：flash 调用失败、超时（20s×2 次尝试）、输出无法解析 → 一律按中立降级或转人工，绝不自动放行硬风险
5. **可回补优先**：`workspace-write`（写工作区）默认放行，越界才走 flash
6. **按会话门控**：只有显式选中「自动审批（Flash）」预设的会话才介入
7. **只预判、不执行**：插件只返回允许/转人工决策，不修改审批流程的其他环节

> 警告：自动审批会显著降低人工介入频率。**仅供可信环境使用**，涉及生产数据、远程系统、支付扣费等高风险场景请保持 `ask` 预设。

## 技术说明

- 挂载于 `approval/request` 瀑布最前（`prepend: true`，先于 web answerer 接单）
- 门控：`permissionPresets.current(session.events) === 'auto-approve'`
- DSH 审批触发点是沙箱越界，`reason` 固定为 `escalate sandbox to <mode>: <justification>`，`mode` 仅 `workspace-write` / `danger-full-access` 两级
- flash 判定：`reasoningEffort: 'off'` + `maxTokens: 64`，输出 `SAFE` 或 `RISKY:<category>`
- 超时兜底：`AbortController` 传入 `llm.stream` 的 signal（可取消底层请求），`Promise.race` + `ctx.timeout(judgeTimeoutMs)`，超时 abort 并重试 1 次
- 学习闭环：通过 waterfall 的 `next()` 返回值捕获人工裁决结果（`allowed-once` 沉淀 / `rejected` 升级）

## License

MIT
