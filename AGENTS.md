# AGENTS.md

思考用简体中文。本文件是 `dsh-approval-gate` 的操作手册：每次对话整份注入，只放每次都要用的定位、红线、流程与命令；机制全文在 [docs/GUIDE.md](docs/GUIDE.md)，每次实测结论在 `docs/VERIFY-<完整版本号>.md`。宿主注入上限 65536 字节，超了整份不发。

**典型失败模式是静默降级**：插件加载完全正常、路由全部 200、不报错也不崩溃，只是悄悄退回人工审批。只过语法检查不算完成，按第 6 节实测。

## 1. 新对话先做什么

1. `git branch --show-current`：确认在 `<目标完整版本号>/dev`；不在就按第 5 节开分支，并确认工作区里的未提交改动属于本轮。
2. 按任务读文档，不要通读仓库：判定管道、数据文件、API、预设自举看 [docs/GUIDE.md](docs/GUIDE.md)；换 harness 版本看第 3 节「已知 API 漂移」；发布看第 5 节。
3. 改完 host 代码必须让实例重启 `dsh web` 才生效（ESM 模块，已加载的旧代码不会自己更新；动态插件有时会热加载，但别依赖）。
4. 改判定逻辑后按第 6 节自检清单实测，覆盖普通升权、删除语义、同一操作第二次三类用例。
5. 验证完就提交（第 7 节）；发布前过一次隐私检查，清单只在本机文件里。

## 2. 项目地图

一句话定位：DSH 持久插件，挂在审批瀑布 `approval/request` 的最前面，用判定模型预判每次沙箱越界请求能否自动放行。

- 可回补的常规操作 → 自动放行
- 硬风险（`deletion` / `credential` / `remote` / `system` / `bulk`）→ **永远转人工**，不计数、不学习
- 学习只针对人工确认过的操作，沉淀规则带操作指纹

判定管道：`DENY 危险词 → allowRules 白名单 → denyRules → 判定（SAFE / RISKY:<类别>）→ 裁决学习`。超时或调用失败重试 1 次，仍失败 → 转人工（fail-safe）。

| 路径 | 作用 |
| --- | --- |
| `src/index.mjs` | host 端插件：审批钩子、判定管道、学习、HTTP API、快照管理（单文件，无依赖） |
| `client.js` | 浏览器端 bundle，经 `window.__ModuleLoader__.load({ id: 'dsh-approval-gate', factory })` 注册 |
| `cordis.patch.yml` | bundle patch：`insert` 插件行，并给出插件行 `config.judgeModel` 的默认值；`auto-approve` 预设由插件启动时自动写入 profile 的 `cordis.patch.yml` |
| `package.json` | `main` / `exports`（`.` 与 `./client`）、`dsh.bundle.patch`、`dsh.client.platform = web` |
| `docs/GUIDE.md` / `GUIDE.en.md` | 使用与配置指南（中文 / 英文） |
| `docs/VERIFY-<完整版本号>.md` | 每次实测结论与未验证项 |
| `docs/screenshots/` | 审批 UI 截图（发布时会公开，逐张看过再发） |

客户端 UI 两个槽位（详见 `client.js` 头部注释）：`conversation.input.dock`（order 30，自动放行提示条，无事件时完全隐藏不占位）与 `conversation.view`（order 20，「审批」标签页，位于「轨迹」右侧）。样式只用 DSH 设计 token（`--dsw-alias-*` / `--dsh-*`），不要自己造色值。

## 3. 关键机制

**钩子**：`ctx.on('approval/request', async (req, next) => ...)`；不接管时必须 `return next()` 交回下游。`inject` 声明为 `['llm', 'approval', 'permissionPresets', 'agentDefaultModel', 'timer', 'webServer']`。

**触发条件（最容易踩）**：只有当会话当前权限预设等于 `auto-approve` 时才接管：

```js
preset = permissionPresets.current(session)   // 传 Session 对象！
if (preset !== PRESET_NAME) return next()
```

**reason 协议**：DSH 触发的越界请求 reason 固定为 `escalate sandbox to <mode>: <justification>`，`mode` 只有 `workspace-write` 和 `danger-full-access` 两级，由 `parseReason()` 解析。

**判定协议**：`judgeOnce()` 输出 `SAFE` 或 `RISKY:<category>`；`verifySimilarity()` 输出 `SAME` / `DIFFERENT`。判定模型由 `resolveJudgeModel()` 决定，优先级：`allowlist.json` 的 `judgeModel`（热更新；**键存在即说了算**，`''` = 显式跟随会话模型）→ 插件行 `config.judgeModel`（`cordis.patch.yml`，启动时读取）→ `agentDefaultModel.currentSelection()` → 兜底 `deepseek-official / deepseek-flash`。写成 `provider/model` 即「钉死」；删掉 allowlist 的键回到插件行默认值。生效值与来源见 `GET /api/auto-approve/rules` 的 `judge` 字段。

**数据文件**（全部在 `$DSH_HOME/auto-approve/`）：

| 文件 | 作用 |
| --- | --- |
| `allowlist.json` | 配置：`denyKeywords` / `allowRules` / `denyRules` / `hardCategories` / `riskyThreshold` / `judgeTimeoutMs` / `judgeModel` / `learning` / `autoConfigurePreset`；改动即时生效 |
| `learning.json` | 学习状态：`stats` 计数 + `history[key]` 人工确认样本 |
| `audit.log` | 追加式决策流水：`ALLOW` / `HARD` / `RISKY` / `SAME` / `OUTCOME` / `LEARN` |
| `events.jsonl` | UI 时间线数据源 |
| `snapshots/` | 文件改动快照：单文件上限 256KB、每次最多 5 个文件、二进制跳过 |

**HTTP API**（host 端注册，客户端轮询）：

```
GET  /api/auto-approve/events            # 支持 since= / sessionId= 增量
GET  /api/auto-approve/rules              # { config, judge, models, learning, predefined, setup }
GET  /api/auto-approve/setup             # { configured, patchPath, patchPathSource, autoConfigurePreset }
GET  /api/auto-approve/diff?eventId=&path=
POST /api/auto-approve/revert
GET  /api/auto-approve/snapshots-stats
POST /api/auto-approve/snapshots-clear
```

**权限预设自举**：插件加载时若发现当前 profile 还没有 `auto-approve` 预设，会自动把它写进该 profile 的 `cordis.patch.yml`（文本级、保留注释），日志提示重启生效。profile 路径运行时三级解析（`profileContext.patchPath` → `profileContext.dir` → 命令行 `--profile <name>`，源码里不写死实例名）；三级都拿不到就**不写**，只记 warn。关闭：`allowlist.json` 的 `autoConfigurePreset: false`。任何失败只退回「人工配置」，不影响审批链路。解析结果与来源见 `GET /api/auto-approve/setup`。

### 已知 API 漂移（已踩过）

- **`permissionPresets.current()` 在 DSH 0.1.7-rc.2 的签名是 `current(session: Session)`。** 传 `session.events`（数组）会在内部 `sessionProjections.stateOf()` 处抛错，被本插件的 `try/catch` 吞掉后 `return next()`——表现为插件加载正常、路由全部 200，但永远转人工。诊断特征：`GET /api/auto-approve/events` 恒为 `{"events":[]}`，且 `audit.log` 一直不生成。排查入口：`dsh-permission-presets` 的 `current()` / `permissionState()`，官方调用点是同包 `types/index.js` 里的 `this.current(agent.session)`。
- **不要改用 `permissionPresets.registerAuto(admit)`：对本插件是死路。** 内置 `auto` 的规格固定为 `sandbox: danger-full-access`，而 `dsh-sandbox` 的 `approveEscalation()` 只在请求模式**严格宽于**当前模式时才发审批——切到 `auto` 后沙箱全开、不再产生越界请求，门控整条管道永远不会被触发。另外 `registerAuto` 是排他的，会与官方 `dsh-experimental-auto-review` 抢同一个保留位。结论：`auto-approve` 只能走配置层（profile 的 `cordis.patch.yml`）。
- **patch 的覆盖语义是整行替换**：`dsh-base` 的 patch 头声明「后面的 bundle patch 与用户层可按 id 覆盖前面的行，last write wins per row，且整个 `config` 是整体替换而非合并」。把预设写进本仓库 bundle patch 要求重述整张 presets 表、会在 harness 升级时盖掉新预设，故未采用。
- **新建 profile 的用户层 `cordis.patch.yml` 默认内容就是 `[]`（flow 空序列）。** 往 `[]` 后面直接拼块序列项会产出非法 YAML，`dsh` 下次启动直接报 `YAMLException … (3:1)` 起不来；本次启动因为配置早已解析完，表现为「插件正常、路由全 200、门控静默不触发」。v1.1.3 起写入前剥掉空的 `[]`，启动时自愈已写坏的文件（`status=repaired-empty-root`），`GET /api/auto-approve/setup` 检出该形态返回 `malformed: true`。排查手法：`dsh --profile <名> --dump-config` 能立刻暴露合成失败。
- **profile patch 不存在**（全新 profile，或被外部启动器在启动失败抢救时改名隔离）时，v1.2.5 起写入器会直接创建一个合法 patch 并写入预设（`status=created`），不再以 `ENOENT` 失败退回人工；`GET /api/auto-approve/setup` 也把「文件不存在」视为未配置而不是错误。

## 4. 工作约束

- ESM（`.mjs`），单文件、无打包、无依赖。`package.json` 没有 `dependencies`，请保持（host 端用 Node 内置模块，客户端用 loader 注入的 `react`）。
- 注释、日志、用户可见文案一律中文；发给模型或接口的机器可读字段用英文。思考用简体中文，最终按用户语言输出。
- 失败语义：**任何异常都必须收敛到「转人工」，绝不能因为报错而放行**。
- 硬类别（`deletion` / `credential` / `remote` / `system` / `bulk`）不得加入 `allowRules`，也不要放宽 `hardCategories` 默认值。
- 客户端 UI 沿用现有槽位与 `order`，不要抢占其他插件的排序。
- 新增或调整判定逻辑时，同步更新 [docs/GUIDE.md](docs/GUIDE.md) 与本文件第 3 节。
- 不要把 token / 凭据写进代码、日志或提交；需要凭据时只在内存里传递。
- 不要提交 `*.bak-*`、`node_modules` 与本地 profile 产物。
- **发布前必须过一次隐私检查**：判据与清单只放在本机文件里（`AGENTS.local.md`，已被 `.gitignore` 忽略），公开仓库里不写——把「我们怕什么被看到」写进公开仓库，等于把答案一并公开。本仓库还会公开 `docs/screenshots/` 里的图，截图要逐张看过。

## 5. 版本与分支

版本号独立于 harness 版本，两者拼成完整版本号：`<harness 版本>-v<插件版本>`，例如 `0.2.2-rc.3-v1.2.5`。`package.json` 的 `version` 是唯一真源，同时是版本分支名、tag 名 `release/<完整版本号>` 与 GitHub Release 的标题（标题不带 `release/` 前缀）。不要在 README、源码或别处重复维护。

| 位 | 递增条件 | 旧版本分支 |
| --- | --- | --- |
| X（主版本） | 不兼容的破坏性变更（`allowlist.json` 结构变化、判定协议不兼容旧配置） | 每个更早 X 线只留最新一条 |
| Y（次版本） | 向后兼容的新功能（新判定层、新 UI 槽位） | 每个旧 Y 线只留最新一条 |
| Z（修订版） | 向后兼容的 bug 修复 | 全部保留 |

- 换 harness 版本 = 新开一条版本线，插件版本继续累加，不重置。源码里已无硬编码 harness 版本或 profile 名（第 3 节），不用再同步改常量；但仍要按第 6 节实测，`permissionPresets.current(session)` 这类漂移恰恰是换版本时最容易踩的坑。
- 实验版本 `X.Y.Z-expN` 不占正式号，转正时修订版 +1（`1.1.0-exp4 → 1.1.1`）；实验版本同样写进 `package.json`，dev 分支名也用它。

### 发布流程

每个已发布的完整版本对应一条版本分支（分支名 = 完整版本号）。改动先落在以目标版本命名的 `/dev` 分支上，验收通过后把 dev 改名成版本分支即可发布。**开工前先定版本号**（评错了 `git branch -m` 改名重来），版本号要落在 dev 的第一个提交里。

```powershell
# 1) 从当前版本分支切 dev，改 package.json version，提交 start
git checkout <已发布的完整版本号>
git checkout -b <目标完整版本号>/dev
git commit -am "chore: start <目标完整版本号>"

# 2) 开发 → node --check → 按第 6 节实测 → 按第 7 节提交
git push -u origin <目标完整版本号>/dev

# 3) 发布前隐私检查（清单只在本机），然后把 dev 改名成版本分支
git branch -m <目标完整版本号>/dev <目标完整版本号>
git push origin --delete <目标完整版本号>/dev     # 必须先删远端 dev，否则目录前缀冲突
git push -u origin <目标完整版本号>
git tag release/<目标完整版本号>
git push origin release/<目标完整版本号>          # 先推 tag
gh release create release/<目标完整版本号> --repo ventisyn/dsh-approval-gate --title "<目标完整版本号>" --notes-file <说明.md> --verify-tag
gh api -X PATCH repos/ventisyn/dsh-approval-gate -f default_branch=<目标完整版本号>
```

- **每次发布都要建 GitHub Release，不能只打 tag**：DSHL 的版本列表分别抓 `releases` 与 `tags` 两个接口，裸 tag 显示为「标签」，只有 Release 才显示「正式版」；列表渲染的是 Release 的标题，所以标题写干净版本号。tag 名带 `release/` 前缀、分支名不带：两者同名会让 git 报 `refname is ambiguous`。
- **先删远端 `/dev`，再推版本分支**：远端不能同时存在 `refs/heads/X` 与 `refs/heads/X/dev`，否则 GitHub 以 `directory file conflict` 拒绝。`/dev` 同时只有一条，改名成版本分支后下一轮再开。
- **先推 tag 再建 Release**：`gh release create` 在远端 tag 不存在时会基于**当时的默认分支**建 tag（踩过：tag 指到了上一个版本的提交，只能删 tag / Release 重建），所以用 `--verify-tag`。
- **每次发布后把 GitHub 默认分支移到新版本**：仓库首页与 `git clone` 默认取的就是它，停在旧版本等于向访客展示过时代码；默认分支也无法被 `--delete`。
- 版本分支只由 dev 改名产生：不要直接在版本分支上提交，也不要为同一个版本另开分支。
- 保留策略（按插件版本分组，不区分 harness 前缀）：Z 不删任何旧分支；Y 按 `X.Y` 分组每组只留最新一条；X 每个更早主版本线只留最新一条。删分支前确认该版本 tag 已推送，这样删掉仍能靠 tag 回溯；要删的分支如果是默认分支，先切默认分支。

### 在 dev 分支上验证

```powershell
# 方式一：从 dev 分支装（pnpm 按分支名解析 ref）
dsh plugin --profile <profile 名> add github:ventisyn/dsh-approval-gate#<目标完整版本号>/dev

# 方式二（推荐，迭代最快）：链接本地工作副本，改完重启/热加载即生效
dsh plugin --profile <profile 名> add link:<本地 clone 路径>
```

⚠️ 用方式一验证完，记得把 profile 切回已发布版本分支的 ref，否则会一直跟着 dev 跑。pnpm 的 lockfile 锁的是 commit hash，推了新提交后必须重跑一次 `add`。

## 6. 测试与验收

语法自检（等同 `npm test`）：

```powershell
node --check src/index.mjs && node --check client.js
```

任何判定逻辑的改动都按这个顺序实测（只通过语法检查不算完成）：

1. 语法自检通过。
2. 装进 profile 并**重启 `dsh web`**（host 端是 ESM 模块，已加载的旧代码不会自己更新）。
3. 触发一次越界请求，确认：
   - `GET /api/auto-approve/events` 非空
   - `$DSH_HOME/auto-approve/audit.log` 新增一行，且决策符合预期：安全操作 → `ALLOW ... (flash-safe)` / `(rule)` / `(flash-same)`；硬类别 → `HARD ... category=<cat> → 人工`
   - 用例至少覆盖三类：① 普通升权（应自动放行）② 含删除语义（应转人工）③ 同一操作第二次（应命中 `flash-same` 或规则）
4. 人工确认过一次后，`learning.json` 的 `stats` / `history` 应有对应沉淀。
5. 把结论与未验证项写进 `docs/VERIFY-<完整版本号>.md`，含「仍然未验证」一节。

| 反复错误 | 强制检查 |
| --- | --- |
| 只跑了 `node --check` 就当完成 | 第 6 节第 2–4 步 |
| 判定模型/预设被改后不核对生效值 | `GET /api/auto-approve/rules` 的 `judge` 字段 |
| 新 profile / 被隔离的 patch 上预设没写进去 | `GET /api/auto-approve/setup` 的 `configured` 与 `patchPathSource` |

## 7. Git 提交规范

格式 `type[(scope)]: description`。**提交信息（标题与正文）统一用英文**；代码注释、日志与 UI 文案仍是中文，两者不要混。历史提交中的中文信息保持原样，不改写已推送的提交。

| 类型 | 用于 | 范围 | 对应 |
| --- | --- | --- | --- |
| `feat` | 新增功能（新判定层、新 UI 槽位、新 API） | `host` | `src/index.mjs` 的插件主体 / 生命周期 |
| `fix` | 修复 bug（判定错误、快照断档、UI 异常） | `judge` | 判定管道（DENY / 白名单 / 判定 / 裁决） |
| `refactor` | 重构 / 调整结构，不改变外部行为 | `learn` | 样本沉淀与同类语义验证 |
| `docs` | 文档（README / GUIDE / AGENTS.md） | `ui` | `client.js` 的提示条与「审批」视图 |
| `style` | 格式调整，不影响逻辑 | `snapshot` | diff 快照与撤销 |
| `test` | 测试相关（本仓库目前只有 `node --check`） | `api` | `/api/auto-approve/*` 路由 |
| `build` | 构建 / 依赖变更（`files`、`exports`、`dsh` 字段） | `preset` | 预设、启动时自动写入与 profile 路径解析 |
| `chore` | 其他杂项（版本号、注释） | `deps` | DSH API 适配（版本漂移） |

- 英文祈使句、小写开头、结尾不加句号：`fix the path resolution in snapshot capture`（不是 `Fixed ...` / `fixes ...`）。标题 72 字符以内，细节放正文。
- **每次改完代码顺手提交**，不要把多件事攒成一条。一条提交只做一件事，行为改动与纯格式改动不混在同一条。
- 涉及判定逻辑的改动，正文补**根因**与**验证方式**（第 6 节自检清单的哪几项）。
- 提交前必须通过语法自检。提交信息与文件内容里不出现 token、凭据、本机绝对路径等敏感信息。
- 示例：`fix(judge): adapt permissionPresets API for DSH 0.1.7-rc.2`、`fix(snapshot): resolve real paths by tracing tool-call args`、`feat(ui): show the auto-approval timeline per session`、`docs: document the v0.5.0 diff and snapshot management`。

## 8. 常用命令

```powershell
# 语法自检
node --check src/index.mjs && node --check client.js

# 装进 profile
dsh plugin --profile <profile 名> add github:ventisyn/dsh-approval-gate#<已发布的完整版本号>
dsh plugin --profile <profile 名> add link:<本地 clone 路径>

# 观察判定是否在工作
Get-Content $env:USERPROFILE\.dsh\auto-approve\audit.log -Tail 20
```

本机特有的坑（沙箱升权行为、`github.com` 连接抖动、实例与端口）见 `AGENTS.local.md`，本文件不复述，避免腐烂。

详细文档：[使用与配置指南](docs/GUIDE.md) · [英文指南](docs/GUIDE.en.md) · [README](README.md)

## 附录：旧节号对照

| 旧编号 | 现在 |
| --- | --- |
| 旧 §1「这是什么」 | §2 |
| 旧 §2「仓库结构」 | §2 |
| 旧 §3「关键机制」 | §3 |
| 旧 §4「与 DSH 版本的耦合点」+ 已知 API 漂移 | §3（机制 + 漂移）+ §5（耦合表） |
| 旧 §5「开发环境」 | §6 + §8 + 本机文件 `AGENTS.local.md` |
| 旧 §6「编码约定」+ 旧 §8「安全红线」 | §4 |
| 旧 §7「Git 提交规范」 | §7 |
| 旧 §9「改完自检清单」 | §6 |
| 旧 §10「分支开发流程」+ §11「版本号规范」 | §5 |
