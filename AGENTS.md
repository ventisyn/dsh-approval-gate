# AGENTS.md

给在本仓库工作的 AI 编码代理（以及新加入的人）的操作手册。

**动手前先读第 4 节「与 DSH 版本的耦合点」、第 7 节「Git 提交规范」、第 10 节「分支开发流程」与第 11 节「版本号规范」；改完按第 9 节自检清单实测。** 这个插件的失败模式大多是**静默降级**：不报错、不崩溃、路由全部 200，只是悄悄退回人工审批。

## 1. 这是什么

`dsh-approval-gate` 是 DeepSeek Harness（DSH）的持久插件，挂在审批瀑布 `approval/request` 的最前面，用 Flash 模型预判每次「沙箱越界」请求能否自动放行：

- 可回补的常规操作 → 自动放行
- 硬风险（`deletion` / `credential` / `remote` / `system` / `bulk`）→ **永远转人工**，不计数、不学习
- 学习只针对人工确认过的操作，沉淀规则带操作指纹

判定管道：`DENY 危险词 → allowRules 白名单 → denyRules → Flash（SAFE / RISKY:<类别>）→ 裁决学习`。
超时或调用失败重试 1 次，仍失败 → 转人工（fail-safe）。

## 2. 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/index.mjs` | host 端插件：审批钩子、判定管道、学习、HTTP API、快照管理（约 1500 行，无依赖） |
| `client.js` | 浏览器端 bundle，经 `window.__ModuleLoader__.load({ id: 'dsh-approval-gate', factory })` 注册 |
| `cordis.patch.yml` | bundle patch：只负责 `insert` 插件行；`auto-approve` 预设必须由 profile 手动添加（动态插件无法扩展冻结的 presets 表） |
| `package.json` | `main` / `exports`（`.` 与 `./client`）、`dsh.bundle.patch`、`dsh.client.platform = web` |
| `docs/` | `GUIDE.md`、`GUIDE.en.md`、`VERIFY-*.md`、`screenshots/` |

两个客户端 UI（详见 `client.js` 头部注释）：

- `conversation.input.dock`（order 30）：自动放行提示条，无事件时完全隐藏不占位
- `conversation.view`（order 20）：「审批」标签页，位于「轨迹」右侧

样式只用 DSH 设计 token（`--dsw-alias-*` / `--dsh-*`），不要自己造色值。

## 3. 关键机制

**钩子**：`ctx.on('approval/request', async (req, next) => ...)`；不接管时必须 `return next()` 交回下游。
`inject` 声明为 `['llm', 'approval', 'permissionPresets', 'agentDefaultModel', 'timer', 'webServer']`。

**触发条件（最容易踩）**：只有当会话当前权限预设等于 `auto-approve` 时才接管：

```js
preset = permissionPresets.current(session)   // 传 Session 对象！
if (preset !== PRESET_NAME) return next()
```

**reason 协议**：DSH 触发的越界请求 reason 固定为 `escalate sandbox to <mode>: <justification>`，`mode` 只有 `workspace-write` 和 `danger-full-access` 两级，由 `parseReason()` 解析。

**Flash 协议**：`judgeOnce()` 输出 `SAFE` 或 `RISKY:<category>`；`verifySimilarity()` 输出 `SAME` / `DIFFERENT`。模型由 `resolveModel()` 决定：优先 `agentDefaultModel.currentSelection()`，兜底 `deepseek-official / deepseek-v4-flash`。

**数据文件**（全部在 `$DSH_HOME/auto-approve/`，`DSH_HOME` 默认 `~/.dsh`）：

| 文件 | 作用 |
| --- | --- |
| `allowlist.json` | 配置：`denyKeywords` / `allowRules` / `denyRules` / `hardCategories` / `riskyThreshold` / `judgeTimeoutMs` / `learning`；**改动即时生效（热更新）** |
| `learning.json` | 学习状态：`stats` 计数 + `history[key]` 人工确认样本 |
| `audit.log` | 追加式决策流水：`ALLOW` / `HARD` / `RISKY` / `SAME` / `OUTCOME` / `LEARN` |
| `events.jsonl` | UI 时间线数据源 |
| `snapshots/` | 文件改动快照：单文件上限 256KB、每次最多 5 个文件、二进制跳过 |

**HTTP API**（host 端注册，客户端轮询）：

```
GET  /api/auto-approve/events            # 支持 since= / sessionId= 增量
GET  /api/auto-approve/rules
GET  /api/auto-approve/setup             # { configured, patchPath }
GET  /api/auto-approve/diff?eventId=&path=
POST /api/auto-approve/revert
GET  /api/auto-approve/snapshots-stats
POST /api/auto-approve/snapshots-clear
```

## 4. 与 DSH 版本的耦合点 ⚠️

**分支名是完整版本号，profile 名只是其中的 harness 版本 —— 两者不再相等**，改动时必须分别对齐（当前：分支 `0.1.7-rc.2-v1.0.0`，profile `0.1.7-rc.2`）。

| 位置 | 取值 | 什么时候改 |
| --- | --- | --- |
| 分支名 / 安装 ref | `0.1.7-rc.2-v1.0.0`（harness 版本 + 插件版本） | 每次发布新版本 → 新建版本分支（第 10 节） |
| `package.json` 的 `version` | `0.1.7-rc.2-v1.0.0`，与分支名一致 | 同上（第 11 节） |
| `src/index.mjs` 的 `PROFILE_PATCH_PATH` | `join(DSH_HOME, 'profiles', '0.1.7-rc.2', 'cordis.patch.yml')` —— **只到 harness 版本** | 仅当换 harness 版本 |

`PROFILE_PATCH_PATH` 决定设置页「一键初始化预设」写哪个 profile 的 `cordis.patch.yml`；指向不存在的 profile 等于没配置（上游默认写死 `web`，与本机不符）。

### 已知 API 漂移（已踩过）

- **`permissionPresets.current()` 在 DSH 0.1.7-rc.2 的签名是 `current(session: Session)`。** 传 `session.events`（数组）会在内部 `sessionProjections.stateOf()` 处抛错，被本插件的 `try/catch` 吞掉后 `return next()` —— 表现为**插件加载完全正常、路由全部 200，但永远转人工**。
  - 诊断特征：`GET /api/auto-approve/events` 恒为 `{"events":[]}`，且 `$DSH_HOME/auto-approve/audit.log` **一直不生成**。
  - 排查入口：`node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js` 的 `current()` / `permissionState()`；官方调用点是同包 `types/index.js` 里的 `this.current(agent.session)`。
- DSH 0.1.7-rc.2 已提供 `permissionPresets.registerAuto(admit)` 与内置 `auto` 预设，是本插件后续更正规的接入点（当前实现硬编码 `auto-approve` 预设名）。

## 5. 开发环境

- **无构建步骤、零运行时依赖**：`package.json` 没有 `dependencies`，请保持（host 端用 Node 内置模块，客户端用 loader 注入的 `react`）。
- 语法自检（等同 `npm test`）：`node --check src/index.mjs && node --check client.js`。
- 本机为 Windows + PowerShell，DSH 以 `DSH_HOME=C:\Users\venti\.dsh`、profile `0.1.7-rc.2` 运行，Web 端口当前为 10723。

### 装进 profile 验证

```powershell
# git 引用（正式）
dsh plugin --profile 0.1.7-rc.2 add github:ventisyn/dsh-approval-gate#0.1.7-rc.2-v1.0.0

# 本地链接（开发期更快，改完重启/热加载即生效）
dsh plugin --profile 0.1.7-rc.2 add link:D:\venti\Projects\VScodeProjects\javaScripProjects\dsh-approval-gate
```

⚠️ pnpm 的 lockfile 锁的是 **commit hash**（`pnpm-lock.yaml` 里记的是 `codeload.github.com/.../tar.gz/<sha>`）。**推了新提交后必须重跑一次 `add`**，否则装进去的还是旧 commit。

### 本机特有的坑

- 该工作区上 `workspace-write` 沙箱无法物化 ACL（`SetNamedSecurityInfoW` 报 Win32 5，非管理员进程），**任何受限工具调用都会先失败、再升权到 `danger-full-access`**。因此实际流经门控的几乎全是 `danger-full-access` 升权请求，`allowRules` 里那条 `workspace-write` 规则在本机基本用不上。以管理员身份启动 `dsh web` 可根治。
- `github.com:443` 偶发连接超时（同时 `api.github.com` 正常），push / fetch 失败先重试。

## 6. 编码约定

- ESM（`.mjs`），单文件、无打包、无依赖。
- 注释、日志、用户可见文案一律中文。
- 保持失败语义：**任何异常都必须收敛到「转人工」，绝不能因为报错而放行**。
- 客户端 UI 沿用现有槽位与 `order`，不要抢占其他插件的排序。
- 新增或调整判定逻辑时，同步更新 `docs/GUIDE.md` 与本文件第 3 节。

## 7. Git 提交规范

**每次改完代码顺手提交**，不要把多件事攒成一条。提交信息用约定式格式：

```
type[(scope)]: description
```

> **提交信息（标题与正文）统一用英文。** 代码里的注释、日志与 UI 文案仍然是中文（见第 6 节），两者不要混。历史提交中的中文信息保持原样，不改写已推送的提交。

### 类型（必填）

| 类型 | 用于 |
| --- | --- |
| `feat` | 新增功能（新判定层、新 UI 槽位、新 API） |
| `fix` | 修复 bug（判定错误、快照断档、UI 异常） |
| `refactor` | 重构 / 调整结构，不改变外部行为 |
| `docs` | 文档（README / GUIDE / AGENTS.md） |
| `style` | 格式调整，不影响逻辑 |
| `test` | 测试相关（本仓库目前只有 `node --check`，见第 5 节） |
| `build` | 构建 / 依赖变更（`package.json` 的 `files`、`exports`、`dsh` 字段等） |
| `chore` | 其他杂项（版本号、注释等） |

### 范围（可选，推荐填）

用括号标注改动落在哪个模块。本仓库常用范围：

| 范围 | 对应 |
| --- | --- |
| `host` | `src/index.mjs` 的插件主体 / 生命周期 |
| `judge` | 判定管道（DENY / 白名单 / Flash / 裁决） |
| `learn` | 样本沉淀与同类语义验证 |
| `ui` | `client.js` 的提示条与「审批」视图 |
| `snapshot` | diff 快照与撤销 |
| `api` | `/api/auto-approve/*` 路由 |
| `preset` | `auto-approve` 预设与 `PROFILE_PATCH_PATH` 相关 |
| `deps` | DSH API 适配（版本漂移） |

### 描述

- 英文**祈使句**、小写开头、结尾不加句号：`fix the path resolution in snapshot capture`（而不是 `Fixed ...` / `fixes ...`）。
- 一行标题控制在 72 字符以内，细节放正文。
- 涉及判定逻辑的改动，在正文里补**根因**与**验证方式**（第 9 节自检清单的哪几项）。

### 示例

```
fix(judge): adapt permissionPresets API for DSH 0.1.7-rc.2
fix(snapshot): resolve real paths by tracing tool-call args
fix(ui): stop read-only bash commands from producing fake snapshots
feat(ui): show the auto-approval timeline per session
docs: document the v0.5.0 diff and snapshot management
chore: bump version to 0.1.7-rc.2-v1.0.1
```

### 硬性要求

- 提交前必须通过 `node --check src/index.mjs && node --check client.js`。
- 一条提交只做一件事：**行为改动与纯格式改动不要混在同一条提交里**。
- 提交信息与文件内容里**不要出现 token、凭据、本机绝对路径**等敏感信息。

## 8. 安全红线

- 硬类别（`deletion` / `credential` / `remote` / `system` / `bulk`）不得加入 `allowRules`，也不要放宽 `hardCategories` 默认值。
- 不要把 token / 凭据写进代码、日志或提交；需要凭据时用 `git credential fill` 之类方式**只在内存里传递**。
- 不要提交 `*.bak-*`、`node_modules` 与本地 profile 产物。

## 9. 改完自检清单

任何判定逻辑的改动，都按这个顺序实测（**只通过语法检查不算完成**）：

1. `node --check src/index.mjs && node --check client.js`
2. 装进 profile 并**重启 `dsh web`**（host 端是 ESM 模块，已加载的旧代码不会自己更新；动态插件在文件改动后有时会热加载，但别依赖）
3. 触发一次越界请求，确认：
   - `GET http://127.0.0.1:10723/api/auto-approve/events` **非空**
   - `$DSH_HOME/auto-approve/audit.log` 新增一行，且决策符合预期：
     - 安全操作 → `ALLOW ... (flash-safe)` / `(rule)` / `(flash-same)`
     - 硬类别 → `HARD ... category=<cat> → 人工`
   - 用例至少覆盖：① 普通升权（应自动放行）② 含删除语义（应转人工）③ 同一操作第二次（应命中 `flash-same` 或规则）
4. 人工确认过一次后，`learning.json` 的 `stats` / `history` 应有对应沉淀

## 10. 分支开发流程

**每个已发布的完整版本对应一条版本分支**（分支名 = 完整版本号）。开发在它下面的 `/dev` 分支上进行，验收通过后合入版本分支；旧版本分支按下面的保留策略处理。

```
0.1.7-rc.2-v1.0.0       ← 已发布的版本分支
0.1.7-rc.2-v1.0.0/dev   ← 当前开发分支（跟随最新已发布版本）
```

### 日常开发

```powershell
git checkout 0.1.7-rc.2-v1.0.0
git pull
git checkout 0.1.7-rc.2-v1.0.0/dev        # 第一次用 -b 创建，之后直接 checkout

# ...改代码...
node --check src/index.mjs && node --check client.js

# 按第 9 节自检清单实测：装进 profile → 重启 dsh web → 触发越界 → 看 events / audit.log

git commit -m "fix(judge): ..."            # 提交规范见第 7 节，可以多条
git push -u origin 0.1.7-rc.2-v1.0.0/dev
```

### 发布新版本（新建版本分支，不改名）

```powershell
# 0) dev 上已开发完且验收通过（第 9 节清单全过）
# 1) 以最新版本分支为基线，新建下一条版本分支
git checkout 0.1.7-rc.2-v1.0.0
git checkout -b 0.1.7-rc.2-v1.0.1
# 2) 合入 dev
git merge --no-ff 0.1.7-rc.2-v1.0.0/dev -m "chore: merge 0.1.7-rc.2-v1.0.0/dev into 0.1.7-rc.2-v1.0.1"
# 3) 改 package.json 的 version 并提交
git commit -am "chore: bump version to 0.1.7-rc.2-v1.0.1"
# 4) 打 tag + 推送
git tag release/0.1.7-rc.2-v1.0.1
git push -u origin 0.1.7-rc.2-v1.0.1 --tags
# 5) dev 分支改名跟随新版本
git branch -m 0.1.7-rc.2-v1.0.0/dev 0.1.7-rc.2-v1.0.1/dev
git push -u origin 0.1.7-rc.2-v1.0.1/dev
git push origin --delete 0.1.7-rc.2-v1.0.0/dev
# 6) 按下面的保留策略清理旧版本分支
```

注意 `/dev` 分支始终只有一条，名字跟随**最新已发布版本**；它自己不进保留策略。

### 版本分支保留策略

按**插件版本**分组处理（不区分 harness 前缀）。新发布的版本本身永远保留：

| 本次发布的位 | 动作 |
| --- | --- |
| **Z**（修订版） | 不删任何旧分支 |
| **Y**（次版本） | 按 `X.Y` 分组，**每组只保留最新一条**（同组内更早的 Z 会被删） |
| **X**（主版本） | 按 `X` 分组，**每个更早的主版本线只保留最新一条** |

分支名省略 `0.1.7-rc.2-` 前缀，连续发布时的演进：

| 发布 | 位 | 保留的分支 |
| --- | --- | --- |
| `1.0.0` | — | `1.0.0` |
| `1.0.1` | Z | `1.0.0`、`1.0.1` |
| `1.1.0` | Y | `1.0.1`、`1.1.0`（删除 `1.0.0`） |
| `1.1.1` | Z | `1.0.1`、`1.1.0`、`1.1.1` |
| `1.2.0` | Y | `1.0.1`、`1.1.1`、`1.2.0`（删除 `1.1.0`） |
| `2.0.0` | X | `1.2.0`、`2.0.0`（删除 `1.0.1`、`1.1.1`） |
| `2.1.0` | Y | `1.2.0`、`2.0.0`、`2.1.0` |
| `3.0.0` | X | `1.2.0`、`2.1.0`、`3.0.0`（删除 `2.0.0`） |

要点：

- 分组只看**插件版本**，不区分 harness 前缀 —— 插件版本全局单调递增，跨 harness 也照常比较（第 11 节）。
- 同一主版本线内，Y 发布收敛的是**旧 Y 线**（每个 `X.Y` 留一条），X 发布收敛的是**整条旧主版本线**（每个 `X` 留一条）。
- 删分支前先确认该版本 tag 已推送（`git push origin --tags`），这样分支删掉仍能靠 tag 回溯。
- 删远端分支：`git push origin --delete <分支名>`。**如果要删的正好是 GitHub 默认分支，必须先切默认分支**（Settings → General → Default branch），否则会被拒绝。
- `/dev` 分支不进这套策略，它始终只有一条。

### 在 dev 分支上验证插件

```powershell
# 方式一：从 dev 分支装（pnpm 按分支名解析 ref）
dsh plugin --profile 0.1.7-rc.2 add github:ventisyn/dsh-approval-gate#0.1.7-rc.2-v1.0.0/dev

# 方式二（推荐，迭代最快）：链接本地工作副本，改完重启/热加载即生效
dsh plugin --profile 0.1.7-rc.2 add link:D:\venti\Projects\VScodeProjects\javaScripProjects\dsh-approval-gate
```

⚠️ 用方式一验证完，记得把 profile 切回版本分支的 ref（`#0.1.7-rc.2-v1.0.0`），否则会一直跟着 dev 跑。

## 11. 版本号规范

本插件的版本号**独立于 harness 版本号**，两者拼成完整版本号：

```
<harness 版本>-v<插件版本>          例如 0.1.7-rc.2-v1.0.0
```

- **harness 版本**：`0.1.7-rc.2`。它同时是 **profile 目录名**（`~/.dsh/profiles/0.1.7-rc.2`）与 `PROFILE_PATCH_PATH` 里的那一段（第 4 节）。换 harness 版本 = 新开一条版本线。
- **插件版本**：`X.Y.Z`，本插件初代版本为 `v1.0.0`；跨 harness 版本**继续累加**，不重置。
- **完整版本号**：写进 `package.json` 的 `version` —— **这是唯一真源**；它同时是**版本分支名**（第 10 节）与发布 tag `release/<完整版本号>` 的名字。不要在 README、源码或别处重复维护。

### X.Y.Z 的含义

| 位 | 递增条件 | 旧版本分支 |
| --- | --- | --- |
| X（主版本） | 不兼容的破坏性变更，例如 `allowlist.json` 结构变化、判定协议不再兼容旧配置 | 每个更早 X 线只留最新一条 |
| Y（次版本） | 向后兼容的新功能，例如新增判定层、新增 UI 槽位 | 每个旧 Y 线只留最新一条 |
| Z（修订版） | 向后兼容的 bug 修复 | 全部保留 |

（保留策略的完整说明与例子在第 10 节。）

### 实验版本

- 格式 `X.Y.Z-expN`（例 `1.1.0-exp1`），**不占用正式版本号**，用于在 `/dev` 上反复试的改动。
- 转正时正式版本的**修订版 +1**：`1.1.0-exp4 → 1.1.1`。实验版本号与它的 git tag **保留**，可回溯（双版号）。
- 实验版本同样写进 `package.json`，即 `0.1.7-rc.2-v1.1.0-exp1`；此时**不开版本分支**（版本分支只对应已发布版本）。

### 发布时与版本号有关的动作

完整流程见第 10 节，这里只列版本号本身：

1. 改 `package.json` 的 `version` 为新完整版本号（例 `0.1.7-rc.2-v1.0.0 → 0.1.7-rc.2-v1.0.1`），提交：
   `chore: bump version to 0.1.7-rc.2-v1.0.1`
2. 打 tag：`git tag release/0.1.7-rc.2-v1.0.1`（加 `release/` 前缀是为了避开"分支名 = tag 名"导致的 `refname is ambiguous`）

⚠️ 换 harness 版本时（例如 DSH 升到 `0.1.8`）：新开版本分支 `0.1.8-v1.0.1`、同步改 `PROFILE_PATCH_PATH`（第 4 节），**插件版本继续累加**，不要重置回 v1.0.0。
