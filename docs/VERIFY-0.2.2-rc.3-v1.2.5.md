# VERIFY — 0.2.2-rc.3-v1.2.5

> 适配 + 修复版本：在 DeepSeek Harness 0.2.2-rc.3 上验证；并修复「profile 的
> `cordis.patch.yml` 不存在时预设自举直接失败」——现在会创建文件，而不是退回人工。

## 1. 变更

| 位置 | 处理 |
| --- | --- |
| `src/index.mjs` | `getSetupState()` 把 `ENOENT` 视为「未配置」（不再当错误）；`ensureAutoApprovePreset()` 在 patch 不存在时按空文档处理并创建（`status=created`）。 |
| `package.json` | 版本升到 `0.2.2-rc.3-v1.2.5`；`engines.dsh` 提到 `>=0.2.2-rc.3`。 |
| `AGENTS.md` / `docs/GUIDE.md` / `README.md` | 补充「patch 不存在时会创建」的说明。 |

## 2. 适配结论（0.2.2-rc.3）

- host 端只用 `ctx` 运行时服务与 Node 内置模块，不 import `@deepseek-ai/*`；
- `permissionPresets.current(session)` 签名、`approval/request` 事件、`agentDefaultModel.currentSelection()` 与三个客户端槽位在 rc.3 上未变；
- 三条路由（`/api/auto-approve/events`、`/rules`、`/setup`）注册正常，v3 管道挂载正常。

## 3. 实测（临时实例：独立 DSH_HOME + 独立 profile + link 安装）

| 场景 | 结果 |
| --- | --- |
| 全新 profile（没有 `cordis.patch.yml`） | 启动日志「已自动写入 auto-approve 权限预设…（status=created）」；生成的 patch 为合法块序列（无 `[]` 空序列根），含 `permission` 块与四个预设 |
| 第二次启动（patch 已存在） | 不重复写入（文件 SHA-256 前后一致），日志不出现 `created` / `added-*` |
| 插件加载 | v3 管道挂载、三条 API 注册，无报错 |

## 4. 仍然未验证

- 真实审批干预（沙箱越界经判定模型 SAFE / RISKY）与裁决学习：本版没有改动审批链路，沿用 v1.2.4 的结论；
- 浏览器设置页「初始化权限预设」卡片在新建场景下的文案：界面需人工确认。

## 5. 说明

- 隐私检查：已过。
- 触发场景：外部启动器在实例连续启动失败时会把 profile 的 `cordis.patch.yml` 改名隔离；v1.2.5 起即使因此丢失 patch，下次启动也会重建含 `auto-approve` 的合法 patch（其余用户自定义配置仍需人工恢复）。
