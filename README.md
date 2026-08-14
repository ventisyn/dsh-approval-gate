# dsh-approval-gate

DeepSeek Harness 自动审批门控插件 v2：**多级判定管道，安全自动批准、危险转人工（fail-safe）**。

当会话的权限预设为 `auto-approve`（自动审批（Flash））时，每次审批请求（沙箱越界）按四级管道判定：

```
DENY（不可逆危险词）→ 白名单（确定性规则）→ flash 兜底（LLM 多因子）→ 人工学习
```

- **① DENY 层**：`rm -rf` / `drop table` / `force push` / 格式化等不可逆危险词命中 → 转人工（**最高优先，fail-safe**）
- **② 白名单层**：命中规则 → 直接放行（确定性，不过 LLM）。默认规则 `{mode:"workspace-write"}` —— 工作区写入（可回补）自动放行，对应 Claude Code `acceptEdits` / Codex `workspace-write` 哲学
- **③ flash 兜底**：仅 `danger-full-access`（任意文件/系统）越界走 LLM 多因子判断（不可回补 + 敏感资源 + 沙箱模式语义）
- **④ 人工学习**：flash 判 RISKY 转人工、被用户批准 ≥3 次 → 自动沉淀进白名单（`danger-full-access` 永不自动沉淀）

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
| `allowlist.json` | 白名单/黑名单配置（首次运行自动生成默认值） |
| `learning.json` | 学习状态（自动维护，跨会话持久化） |
| `audit.log` | 审计日志（追加式） |

`allowlist.json` 结构：

```json
{
  "denyKeywords": ["rm -rf", "drop table", "force push", "格式化"],
  "allowRules": [
    { "mode": "workspace-write", "description": "工作区写入自动放行" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "特定工具+模式+关键词" }
  ],
  "learning": { "enabled": true, "threshold": 3 }
}
```

- `denyKeywords`：命中即转人工（不可逆危险操作）
- `allowRules`：每条规则 `tool` / `mode` / `contains` 三者均满足才放行（缺省表示任意）
- `learning.threshold`：同一「工具+模式」被人工批准达到该次数后自动沉淀白名单

## 使用

在会话的权限下拉（`/permission` 弹窗或设置页）选中**「自动审批（Flash）」**，该会话即启用自动审批；其他会话不受影响（按会话预设门控）。

## 安全设计

1. **DENY 层最高优先**：不可逆危险词命中即转人工，不消耗模型调用、无误判
2. **fail-safe**：任何异常（flash 调用失败、超时 20s、输出不明确）一律转人工，绝不自动放行
3. **可回补优先**：`workspace-write`（写工作区）默认放行，`danger-full-access`（任意文件/系统）才走 flash 判断
4. **危险操作永不自动沉淀**：学习闭环只沉淀非 danger 模式，`danger-full-access` 永远人工
5. **按会话门控**：只有显式选中「自动审批（Flash）」预设的会话才介入
6. **只预判、不执行**：插件只返回允许/转人工决策，不修改审批流程的其他环节

> 警告：自动审批会显著降低人工介入频率。**仅供可信环境使用**，涉及生产数据、远程系统、支付扣费等高风险场景请保持 `ask` 预设。

## 技术说明

- 挂载于 `approval/request` 瀑布最前（`prepend: true`，先于 web answerer 接单）
- 门控：`permissionPresets.current(session.events) === 'auto-approve'`
- DSH 审批触发点是沙箱越界，`reason` 固定为 `escalate sandbox to <mode>: <justification>`，`mode` 仅 `workspace-write` / `danger-full-access` 两级
- flash 判断参数：`reasoningEffort: 'off'` + `maxTokens: 64`（默认 maxTokens:16 且开推理时输出会被推理 token 耗尽，导致误判 RISKY）
- 超时兜底：`Promise.race` + `ctx.timeout(20s)`
- 学习闭环通过 waterfall 的 `next()` 返回值捕获人工批准结果（`allowed-once`）

## License

MIT
