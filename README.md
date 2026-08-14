# dsh-approval-gate

DeepSeek Harness 自动审批门控插件：**Flash 模型预判风险，安全自动批准，危险转人工**。

当会话的权限预设为 `auto-approve`（自动审批（Flash））时，每次审批请求（写入/命令升级）先由 flash 模型（deepseek-v4-flash）判断该操作是否会造成**无法回补（不可逆）**的后果：

- **可回补（SAFE）** → 自动批准，不弹窗
- **不可回补 / 不确定 / 判断失败 / 超时** → 转人工审批（**fail-safe，绝不自动放行**）

另有**不可逆关键词预检**（`rm -rf` / force push / drop table / 格式化等）直接转人工，省一次 flash 调用。

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
        description: Flash 预判写入/命令是否会造成不可回补的结果：安全自动批准，有风险转人工审批。
```

重启 `dsh web` 后，权限下拉菜单会出现「自动审批（Flash）」选项。

## 使用

在会话的权限下拉（`/permission` 弹窗或设置页）选中**「自动审批（Flash）」**，该会话即启用自动审批；其他会话不受影响（按会话预设门控）。

## 安全设计

1. **fail-safe**：任何异常（flash 调用失败、超时 20s、输出不明确）一律转人工，绝不自动放行
2. **不可逆关键词预检**：命中 `rm -rf`、`push --force`、`drop table`、`mkfs`、`terraform destroy` 等直接转人工，不消耗模型调用
3. **按会话门控**：只有显式选中「自动审批（Flash）」预设的会话才介入
4. **只预判、不执行**：插件只返回允许/转人工决策，不修改审批流程的其他环节
5. 仅用 flash 判断（省额度）；审批请求只携带工具名 + 理由文本，不含完整命令参数

> 警告：自动审批会显著降低人工介入频率。**仅供可信环境使用**，涉及生产数据、远程系统、支付扣费等高风险场景请保持 `ask` 预设。

## 技术说明

- 挂载于 `approval/request` 瀑布最前（`prepend: true`，先于 web answerer 接单）
- 门控：`permissionPresets.current(session.events) === 'auto-approve'`
- flash 判断参数：`reasoningEffort: 'off'` + `maxTokens: 64`（默认 maxTokens:16 且开推理时输出会被推理 token 耗尽，导致误判 RISKY）
- 超时兜底：`Promise.race` + `ctx.timeout(20s)`

## License

MIT
