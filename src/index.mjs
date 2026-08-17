/**
 * dsh-approval-gate — 自动审批（多级判定）持久插件 v3
 *
 * 挂在审批瀑布（approval/request）最前：当会话权限预设为 auto-approve 时，
 * 按「DENY → 白名单 → denyRules → flash（SAFE/硬类别/中立计数）→ 裁决学习」管道判定越界请求。
 *
 * 设计目标：最小人工介入。人工只出现在两类场景：
 *   1. 必须人工确认：DENY 危险词、硬风险类别（deletion/credential/remote/system/bulk）
 *   2. 中立操作（neutral）：前 N-1 次人工确认；阈值状态按「指纹命中 → flash 第三方同类验证 → 人工」分流：
 *      指纹命中（确认样本）→ 自动放行并沉淀规则（{tool,mode,category,contains}）
 *      指纹未命中但有样本 → flash 语义判断是否与确认样本同类（SAME 放行 / DIFFERENT 人工）
 *      无样本 / 判不同 / 验证失败 → 人工确认
 *      拒绝 → 升级为永久人工规则（denyRules）；取消 → 不计数
 *
 * DSH 审批触发点：命令在沙箱内被拒后，模型带 sandbox_permissions 重试，
 * 触发 approval.request，reason 固定为：
 *   `escalate sandbox to <mode>: <justification>`
 * 其中 mode 仅两级：workspace-write（写工作区，可回补）/
 * danger-full-access（任意文件/系统，危险）。
 *
 * flash 判定协议（v3）：输出 `SAFE` 或 `RISKY:<category>`
 *   category ∈ { deletion, credential, remote, system, bulk, neutral }
 *   硬类别（前五个）→ 直接转人工；neutral（中立）→ 计数放行，第 N 次转人工裁决。
 *
 * 超时/失败处理：AbortController + signal 传给 llm.stream（可取消），
 *   超时或失败重试 1 次，仍失败 → 转人工（fail-safe）。
 *
 * 数据文件（跨部署统一放到 DSH_HOME 下，node_modules 可能只读）：
 *   $DSH_HOME/auto-approve/allowlist.json  配置（denyKeywords/allowRules/denyRules/hardCategories/…）
 *   $DSH_HOME/auto-approve/learning.json   学习状态（跨会话持久化）
 *   $DSH_HOME/auto-approve/audit.log       审计（追加式）
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NAME = 'dsh-approval-gate'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'auto-approve')
const ALLOWLIST_PATH = join(DATA_DIR, 'allowlist.json')
const LEARNING_PATH = join(DATA_DIR, 'learning.json')
const AUDIT_PATH = join(DATA_DIR, 'audit.log')
const EVENTS_PATH = join(DATA_DIR, 'events.jsonl')
const PROFILE_PATCH_PATH = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')

// auto-approve 权限预设（一键初始化时写入 cordis.patch.yml 的 permission 条目）
const AUTO_APPROVE_PRESET_YAML = `      auto-approve:
        sandbox: workspace-write
        approval: ask
        name: 自动审批（Flash）
        description: Flash 预判写入/命令是否不可回补：安全自动批准，有风险转人工审批。
`
// 无 permission 条目时追加的完整预设块
const FULL_PERMISSION_BLOCK = `
# ── 自动审批模式（dsh-approval-gate）─────────────────────────
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
`

// 自动放行事件序号（进程内递增，重启后从现有文件恢复，避免与历史重复）
let eventSeq = 0
try {
  const existing = readFileSync(EVENTS_PATH, 'utf8')
  for (const line of existing.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (Number.isInteger(ev.id) && ev.id > eventSeq) eventSeq = ev.id
    } catch { /* 跳过坏行 */ }
  }
} catch { /* 文件不存在：从 0 开始 */ }

/** 从 justification 提取涉及的文件/路径（供审查界面展示） */
function extractFiles(text) {
  const s = String(text || '')
  const found = []
  const seen = new Set()
  const add = (v) => {
    const seg = v.replace(/[，。；、,.;:：\s]+$/g, '').trim()
    if (seg.length >= 3 && seg.length <= 120 && !seen.has(seg)) { seen.add(seg); found.push(seg) }
  }
  for (const m of s.matchAll(/(?:~\/|\/|\.\/)?[\w@.-]+\/[\w@.\/-]+/g)) add(m[0])
  for (const m of s.matchAll(/[\w@.-]+\.(?:md|js|json|ya?ml|env|txt|py|ts|css|html|log|mjs|cjs)/gi)) add(m[0])
  return found.slice(0, 8)
}

/** 记录一次自动放行事件（结构化，供 client 审查界面轮询展示） */
function recordAutoAllow(sessionId, toolName, mode, reason, justification, verdict) {
  eventSeq += 1
  const ev = {
    id: eventSeq,
    ts: new Date().toISOString(),
    sessionId: String(sessionId || ''),
    tool: String(toolName || 'unknown'),
    mode: String(mode || ''),
    reason: String(reason || '').slice(0, 600),
    justification: String(justification || '').slice(0, 400),
    verdict: String(verdict || 'auto'),
    files: extractFiles(justification)
  }
  try {
    ensureDataDir()
    appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n', 'utf8')
  } catch (error) {
    console.error(`[${NAME}] 记录自动放行事件失败`, error)
  }
  return ev
}

// 不可逆危险操作（deny 层，命中即转人工，优先级最高）
const DEFAULT_DENY_KEYWORDS = [
  'rm -rf', 'rm -fr', 'rm -r -f', 'rm --recursive --force',
  'push --force', 'force-push', 'force push', 'drop table', 'drop database',
  'mkfs', 'mkfs.ext', 'format', 'shutdown', 'reboot', 'dd of=',
  'delete from', 'truncate table', 'truncate ', 'terraform destroy', 'revoke',
  '清空数据库', '删除数据库', '格式化', 'sudo rm', 'chmod 777 /',
  'git reset --hard', 'git clean -fd', 'docker rm', 'docker system prune'
]

// 默认白名单规则：工作区写入（可回补）自动放行
const DEFAULT_ALLOW_RULES = [
  { mode: 'workspace-write', description: '工作区写入（可回补，对应 acceptEdits/workspace-write）' }
]

// 硬风险类别：flash 判 RISKY 且命中这些类别 → 直接转人工（不计数、不学习、永远人工）
const DEFAULT_HARD_CATEGORIES = ['deletion', 'credential', 'remote', 'system', 'bulk']

// ---- 规则管理 API 辅助 ----

/** 读取请求体 JSON（参考 dsh-vision-paste 的 POST 处理） */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) { req.destroy(new Error('payload too large')); reject(new Error('payload too large')) }
    })
    req.on('error', (err) => reject(err))
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) }
    })
  })
}

/** 配置快照（供设置页展示；区分预置默认值与当前值） */
function getRulesSnapshot() {
  reloadConfig()
  return {
    config: {
      version: config.version || 3,
      denyKeywords: config.denyKeywords || [],
      allowRules: config.allowRules || [],
      denyRules: config.denyRules || [],
      hardCategories: config.hardCategories || [],
      riskyThreshold: config.riskyThreshold || 3,
      judgeTimeoutMs: config.judgeTimeoutMs || 20000,
      learning: { enabled: learning.enabled !== false }
    },
    learning: {
      stats: learning.stats || {},
      history: learning.history || {}
    },
    predefined: {
      denyKeywords: DEFAULT_DENY_KEYWORDS,
      allowRules: DEFAULT_ALLOW_RULES,
      hardCategories: DEFAULT_HARD_CATEGORIES
    },
    setup: getSetupState()
  }
}

/** 检查权限预设是否已配置（供设置页初始化卡片） */
function getSetupState() {
  try {
    const text = readFileSync(PROFILE_PATCH_PATH, 'utf8')
    return { configured: text.includes('auto-approve:'), patchPath: PROFILE_PATCH_PATH }
  } catch (e) {
    return { configured: false, patchPath: PROFILE_PATCH_PATH, error: String((e && e.message) || e) }
  }
}

/** 一键初始化：在 cordis.patch.yml 中写入 auto-approve 权限预设（文本级操作，保留注释格式） */
function ensureAutoApprovePreset() {
  try {
    const text = readFileSync(PROFILE_PATCH_PATH, 'utf8')
    if (text.includes('auto-approve:')) return { ok: true, status: 'already', needRestart: false }

    const lines = text.split('\n')
    let permIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^- id:\s*permission\s*$/.test(lines[i])) { permIdx = i; break }
    }

    if (permIdx === -1) {
      // 无 permission 条目：追加完整预设块
      const next = text.replace(/\s*$/, '') + FULL_PERMISSION_BLOCK + AUTO_APPROVE_PRESET_YAML
      writeFileSync(PROFILE_PATCH_PATH, next, 'utf8')
      return { ok: true, status: 'added-entry', needRestart: true }
    }

    // 有 permission 条目：在其 presets 块末尾插入 auto-approve
    // presets 子项缩进 6；找到 presets: 后的最后一个缩进 ≥6 的连续行，在其后插入
    let presetsIdx = -1
    for (let i = permIdx; i < lines.length; i++) {
      if (/^ {4}presets:\s*$/.test(lines[i])) { presetsIdx = i; break }
      if (i > permIdx && /^- /.test(lines[i]) && !/^ {2,}- /.test(lines[i])) break // 下一个顶层条目
    }
    if (presetsIdx === -1) {
      // permission 条目存在但没有 presets 键：在 config 下补 presets（简化处理）
      return { ok: false, status: 'no-presets-key', needRestart: false, error: 'permission 条目缺少 presets 键，请手动添加' }
    }
    // 从 presetsIdx 往下找最后一个 presets 子项行（缩进 6 且非注释空行），直到顶层条目/文件尾
    let insertAt = presetsIdx
    for (let i = presetsIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^ {6}\S/.test(line) || /^ {8}\S/.test(line)) { insertAt = i; continue }
      if (/^ {0,4}\S/.test(line) && !/^ {6,}\S/.test(line)) break // 缩进 <6 的非空行 = 离开 presets 区
      if (/^\s*$/.test(line)) continue
    }
    lines.splice(insertAt + 1, 0, AUTO_APPROVE_PRESET_YAML.replace(/\n$/, ''))
    writeFileSync(PROFILE_PATCH_PATH, lines.join('\n'), 'utf8')
    return { ok: true, status: 'added-preset', needRestart: true }
  } catch (e) {
    return { ok: false, status: 'error', needRestart: false, error: String((e && e.message) || e) }
  }
}

/** 规则修改：op=add|remove|set，kind=allowRules|denyRules|denyKeywords|hardCategories|riskyThreshold|judgeTimeoutMs */
function applyRuleOp(op, kind, value) {
  reloadConfig()

  // 数值类配置（阈值/超时）
  if (kind === 'riskyThreshold' || kind === 'judgeTimeoutMs') {
    if (op !== 'set') return { ok: false, error: `${kind} 使用 set 操作` }
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: '无效数值' }
    config[kind] = n
    saveJson(ALLOWLIST_PATH, config)
    audit(`CONFIG  ${kind} → ${n}`)
    return { ok: true, set: true, value: n }
  }

  const list = config[kind]
  if (!Array.isArray(list)) return { ok: false, error: `未知规则类型: ${kind}` }

  if (op === 'add') {
    if (kind === 'denyKeywords' || kind === 'hardCategories') {
      const str = String(value || '').trim()
      if (!str) return { ok: false, error: '值不能为空' }
      if (!list.includes(str)) list.push(str)
    } else {
      if (!value || typeof value !== 'object') return { ok: false, error: '规则必须是对象' }
      const hasAny = value.tool || value.mode || value.category || value.contains
      if (!hasAny) return { ok: false, error: '规则至少需要 tool/mode/category/contains 之一' }
      const dup = list.some((r) => r && r.tool === value.tool && r.mode === value.mode && r.category === value.category && r.contains === value.contains)
      if (!dup) {
        if (!value.description) value.description = '用户自定义'
        list.push(value)
      }
    }
    saveJson(ALLOWLIST_PATH, config)
    return { ok: true, added: true }
  }

  if (op === 'remove') {
    const before = list.length
    if (kind === 'denyKeywords' || kind === 'hardCategories') {
      const str = String(value || '').trim()
      for (let i = list.length - 1; i >= 0; i--) if (String(list[i]) === str) list.splice(i, 1)
    } else {
      const v = value || {}
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i] || {}
        if (r.tool === v.tool && r.mode === v.mode && r.category === v.category && r.contains === v.contains) list.splice(i, 1)
      }
    }
    if (list.length === before) return { ok: false, error: '未找到匹配的规则' }
    saveJson(ALLOWLIST_PATH, config)
    return { ok: true, removed: true }
  }

  return { ok: false, error: `未知操作: ${op}` }
}

const CATEGORY_LABELS = {
  deletion: '删除/覆盖不可再生数据',
  credential: '凭据/密钥/授权修改',
  remote: '远程系统/生产环境/数据库',
  system: '系统级路径/配置',
  bulk: '批量不可回补操作',
  neutral: '中立（无硬风险特征）'
}

const SYSTEM_PROMPT = [
  '你是 AI 编程代理的操作风险评估器。DSH 的审批只发生在「沙箱越界」时，即命令需要比当前更宽的权限才能执行。',
  '',
  '你将收到：工具名、请求升级的目标沙箱模式、以及一句操作理由（justification）。',
  '沙箱模式含义：',
  '- workspace-write：允许写当前工作区（可回补，通常安全）',
  '- danger-full-access：允许写任意文件/系统（不可回补风险高）',
  '',
  '输出规则（只输出一个词，SAFE 或 RISKY:<类别>）：',
  '- SAFE：操作不会造成不可回补后果，且不触碰敏感资源。例如：',
  '   工作区内常规读写、安装/构建、git 常规操作、可再生的临时数据、可撤销的修改、',
  '   个人目录（home）下的配置/项目文件常规编辑（可回补）',
  '- RISKY:<类别>：操作可能造成不可回补后果或触碰敏感资源，类别必须是以下之一：',
  '   deletion —— 删除/覆盖不可再生数据、rm 类危险删除',
  '   credential —— 修改/写入凭据、密钥、token、API key、授权配置',
  '   remote —— 影响远程系统/生产环境/数据库、发送消息/扣费、对外发布',
  '   system —— 系统级路径（/etc、/usr、启动项）、系统配置、shutdown/重启类',
  '   bulk —— 批量覆盖大量文件、格式化、dd 类不可回补操作',
  '   neutral —— 以上都不符合（如：工作区外普通文件的常规编辑、模型不确定但无明显硬风险）',
  '',
  '判定原则：',
  '- 只根据 justification 描述判断，不臆测额外风险',
  '- 可回补、常规、不触碰敏感资源的操作 → SAFE',
  '- 工作区外写入（如 ~/.dsh、个人项目仓库）本身不构成硬风险：判断的是操作内容，不是路径位置',
  '- 拿不准、但无删除/凭据/远程/系统/批量特征的 → neutral（这是误判补偿区，系统会计数后请用户裁决）',
  '',
  '只输出一个词：SAFE 或 RISKY:<类别>。不要输出任何其他内容。'
].join('\n')

function ensureDataDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch { /* 目录创建失败不影响主流程 */ }
}

function loadJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`[${NAME}] 读取 ${path} 失败，用默认值`, error)
    return fallback
  }
}

function saveJson(path, data) {
  try {
    ensureDataDir()
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch (error) {
    console.error(`[${NAME}] 写入 ${path} 失败`, error)
  }
}

function audit(line) {
  try {
    ensureDataDir()
    appendFileSync(AUDIT_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 审计失败不影响主流程 */ }
}

// 首次加载时初始化配置文件；旧版（v1）自动补齐 v3 字段
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  cfg.denyKeywords = cfg.denyKeywords || DEFAULT_DENY_KEYWORDS
  cfg.allowRules = cfg.allowRules || DEFAULT_ALLOW_RULES
  cfg.denyRules = cfg.denyRules || []
  cfg.hardCategories = cfg.hardCategories || DEFAULT_HARD_CATEGORIES
  cfg.riskyThreshold = cfg.riskyThreshold || 3
  cfg.judgeTimeoutMs = cfg.judgeTimeoutMs || 20000
  cfg.learning = cfg.learning || { enabled: true }
  return cfg
}

let config = loadJson(ALLOWLIST_PATH, null)
if (!config || typeof config !== 'object') {
  config = {
    version: 3,
    denyKeywords: DEFAULT_DENY_KEYWORDS,
    allowRules: DEFAULT_ALLOW_RULES,
    denyRules: [],
    hardCategories: DEFAULT_HARD_CATEGORIES,
    riskyThreshold: 3,
    judgeTimeoutMs: 20000,
    learning: { enabled: true }
  }
  saveJson(ALLOWLIST_PATH, config)
} else {
  config = normalizeConfig(config)
  if (config.version !== 3) { config.version = 3; saveJson(ALLOWLIST_PATH, config) }
}

// 热更新：每次审批前重新读盘 allowlist.json（小文件、审批频率低，无性能问题），
// 使手动修改配置无需重启即可生效
function reloadConfig() {
  const disk = loadJson(ALLOWLIST_PATH, null)
  if (disk && typeof disk === 'object') {
    const prev = config
    config = normalizeConfig(disk)
    if (!config.version) config.version = prev.version || 3
    learning.enabled = config.learning.enabled !== false
  }
}

const learning = loadJson(LEARNING_PATH, { enabled: true, stats: {}, history: {} })
// enabled 以 allowlist.json 的 learning 段为单一配置源（旧 learning.json 的 enabled 仅作兼容回退）
learning.enabled = config.learning ? config.learning.enabled !== false : learning.enabled !== false
learning.stats = learning.stats || {}
// history：每个 key 最近人工确认过的操作样本（最多 10 个）：
//   { fp: 操作指纹（路径/文件名/项目名，可空）, ctx: 操作背景和目的（justification 摘要） }
// 供「flash 第三方同类验证」判断新操作是否与已确认样本同类。
// 兼容旧格式：字符串数组 → { fp, ctx } 对象数组
learning.history = learning.history || {}
for (const k of Object.keys(learning.history)) {
  if (!Array.isArray(learning.history[k])) learning.history[k] = []
  learning.history[k] = learning.history[k]
    .map((s) => typeof s === 'string' ? { fp: s, ctx: s } : s)
    .filter((s) => s && typeof s === 'object')
    .slice(-10)
}

function looksDeny(text) {
  const lower = String(text || '').toLowerCase()
  const keywords = config.denyKeywords || DEFAULT_DENY_KEYWORDS
  return keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()))
}

// reason 格式：`escalate sandbox to <mode>: <justification>`
function parseReason(reason) {
  const m = String(reason || '').match(/escalate\s+sandbox\s+to\s+([^\s:]+):?\s*([\s\S]*)/i)
  if (m) return { mode: m[1], justification: (m[2] || '').trim() }
  return { mode: '', justification: String(reason || '') }
}

// 规则匹配：tool / mode / category / contains 均满足（缺省表示任意）
function matchRule(rules, toolName, mode, category, justification) {
  const list = rules || []
  const j = String(justification || '').toLowerCase()
  for (const rule of list) {
    if (rule.tool && rule.tool !== toolName) continue
    if (rule.mode && rule.mode !== mode) continue
    if (rule.category && rule.category !== category) continue
    if (rule.contains && !j.includes(String(rule.contains).toLowerCase())) continue
    return rule
  }
  return null
}

// 计数/学习 key：tool|mode|category（category 为 flash 判定的类别，neutral 走计数）
function learnKey(toolName, mode, category) {
  return `${toolName}|${mode || 'none'}|${category || 'none'}`
}

// 从 justification 提取「操作指纹」：路径 / 文件名 / 项目名等有区分度的片段。
// 沉淀/拒绝规则必须携带指纹，避免宽规则（如 edit+danger 放行所有工作区外编辑）
// 误放行用户未确认过的其他操作。提取不到 → 返回 null（调用方决定不沉淀）。
const GENERIC_EN_WORDS = new Set([
  'update', 'updates', 'updating', 'updated', 'install', 'installs', 'installing',
  'deploy', 'deploys', 'deploying', 'sync', 'syncing', 'copy', 'copies', 'move',
  'remove', 'removes', 'adding', 'change', 'changes', 'changing', 'set', 'clean',
  'test', 'verify', 'check', 'fix', 'fixes', 'fixing', 'modify', 'modifies'
])
function extractOperationFingerprint(text) {
  const s = String(text || '')
  const candidates = []
  // 1. 显式路径片段：~/xxx、/xxx/yyy、相对路径（含至少一段目录或文件名）
  for (const m of s.matchAll(/(?:~\/|\/|\.\/)?[\w@.-]+\/[\w@.\/-]+/g)) {
    const seg = m[0].replace(/[，。；、,.;:：\s]+$/g, '').trim()
    if (seg.length >= 5 && seg.length <= 80) candidates.push(seg)
  }
  // 2. 带扩展名的文件名：xxx.md/.js/.json/.yml/.env 等
  for (const m of s.matchAll(/[\w@.-]+\.(?:md|js|json|ya?ml|env|txt|py|ts|css|html|log|mjs|cjs)/gi)) {
    const seg = m[0]
    if (seg.length >= 4 && seg.length <= 60) candidates.push(seg)
  }
  // 3. 连字符/点分隔的项目或插件名（2-4 段英文标识符）
  for (const m of s.matchAll(/\b[a-z][\w-]*(?:[-.][a-z][\w-]*){1,3}\b/gi)) {
    const seg = m[0]
    if (seg.length >= 6 && seg.length <= 50 && !/^(workspace-write|danger-full-access)$/i.test(seg)) {
      candidates.push(seg)
    }
  }
  // 4. 单段英文标识符（≥5 字符，排除通用动词/操作词）：README、config 等文档/配置名
  for (const m of s.matchAll(/\b[a-z][a-z0-9-]{4,}\b/gi)) {
    const seg = m[0]
    if (GENERIC_EN_WORDS.has(seg.toLowerCase())) continue
    if (seg.length <= 40) candidates.push(seg)
  }
  if (candidates.length === 0) return null
  // 取最长片段（最长最有区分度），截断防超长
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0].slice(0, 60)
}

export default {
  name: NAME,
  inject: ['llm', 'approval', 'permissionPresets', 'agentDefaultModel', 'timer', 'webServer'],
  apply(ctx) {
    const llm = ctx.llm
    const permissionPresets = ctx.permissionPresets
    const agentDefaultModel = ctx.get('agentDefaultModel')
    const PRESET_NAME = 'auto-approve'

    // ---- 自动放行事件 API（client 审查界面轮询；按会话过滤 + since 增量） ----
    let offEventsRoute = null
    try {
      if (ctx.webServer && typeof ctx.webServer.register === 'function') {
        offEventsRoute = ctx.webServer.register({
          kind: 'exact',
          path: '/api/auto-approve/events',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
            const url = new URL(req.url, 'http://localhost')
            const sessionId = url.searchParams.get('sessionId') || ''
            const since = Number.parseInt(url.searchParams.get('since') || '0', 10) || 0
            const events = []
            try {
              const text = readFileSync(EVENTS_PATH, 'utf8')
              for (const line of text.split('\n')) {
                if (!line.trim()) continue
                try {
                  const ev = JSON.parse(line)
                  if (!Number.isInteger(ev.id) || ev.id <= since) continue
                  if (sessionId && ev.sessionId !== sessionId) continue
                  events.push(ev)
                } catch { /* 跳过坏行 */ }
              }
            } catch { /* events 文件不存在：返回空 */ }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify({ events }))
          },
        })
        console.log(`[${NAME}] 事件 API 已注册：/api/auto-approve/events`)
      } else {
        console.warn(`[${NAME}] webServer 不可用，审查事件 API 未注册`)
      }
    } catch (error) {
      console.error(`[${NAME}] 注册事件 API 失败`, error)
    }

    // ---- 规则管理 API（设置页：查看/修改放行与阻塞规则 + 一键初始化） ----
    let offRulesRoute = null
    let offSetupRoute = null
    try {
      if (ctx.webServer && typeof ctx.webServer.register === 'function') {
        offRulesRoute = ctx.webServer.register({
          kind: 'exact',
          path: '/api/auto-approve/rules',
          handler: async (req, res) => {
            const send = (code, obj) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
              res.end(JSON.stringify(obj))
            }
            try {
              if (req.method === 'GET' || req.method === 'HEAD') {
                return send(200, getRulesSnapshot())
              }
              if (req.method === 'POST') {
                const body = await readBody(req)
                const op = String(body.op || '')
                const kind = String(body.kind || '')
                const result = applyRuleOp(op, kind, body.value)
                return send(result.ok ? 200 : 400, result)
              }
              return send(405, { ok: false, error: 'method not allowed' })
            } catch (e) {
              send(400, { ok: false, error: String((e && e.message) || e) })
            }
          },
        })
        offSetupRoute = ctx.webServer.register({
          kind: 'exact',
          path: '/api/auto-approve/setup',
          handler: async (req, res) => {
            const send = (code, obj) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
              res.end(JSON.stringify(obj))
            }
            try {
              if (req.method === 'GET' || req.method === 'HEAD') {
                return send(200, getSetupState())
              }
              if (req.method === 'POST') {
                return send(200, ensureAutoApprovePreset())
              }
              return send(405, { ok: false, error: 'method not allowed' })
            } catch (e) {
              send(400, { ok: false, error: String((e && e.message) || e) })
            }
          },
        })
        console.log(`[${NAME}] 规则/初始化 API 已注册：/api/auto-approve/rules, /setup`)
      } else {
        console.warn(`[${NAME}] webServer 不可用，规则/初始化 API 未注册`)
      }
    } catch (error) {
      console.error(`[${NAME}] 注册规则/初始化 API 失败`, error)
    }
    ctx.effect(() => () => {
      if (offEventsRoute) { try { offEventsRoute() } catch (e) {} }
      if (offRulesRoute) { try { offRulesRoute() } catch (e) {} }
      if (offSetupRoute) { try { offSetupRoute() } catch (e) {} }
    })

    const resolveModel = () => {
      try {
        const sel = agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
          ? agentDefaultModel.currentSelection()
          : undefined
        if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
          return { provider: sel.provider, model: sel.model }
        }
      } catch (error) {
        console.error(`[${NAME}] agentDefaultModel.currentSelection() failed`, error)
      }
      return { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    }

    /**
     * 底层 flash 调用：流式请求并累积文本输出（可取消）。
     * 由 judgeOnce / verifySimilarity 共用；异常向上抛，由 withRetry 决定重试或降级。
     * @returns {Promise<string>} 模型原始输出文本
     */
    const callFlash = async (userText, systemPrompt, signal) => {
      const { provider, model } = resolveModel()
      let text = ''
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        system: systemPrompt,
        temperature: 0,
        reasoningEffort: 'off',
        maxTokens: 64,
        signal
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : chunk.reason.kind
          throw new Error('flash 调用失败: ' + failure)
        }
      }
      return text
    }

    /**
     * 单次 flash 判定：输出 SAFE 或 RISKY:<category>。
     * @returns {Promise<{verdict:'safe'|'risky', category?:string}>}
     */
    const judgeOnce = async (toolName, mode, justification, signal) => {
      const user = [
        `工具: ${toolName}`,
        `目标沙箱模式: ${mode || '(非越界审批)'}`,
        `操作理由: ${justification || '(无说明)'}`,
        '',
        '请判断：执行该操作是否会造成无法回补的后果或触碰敏感资源？输出 SAFE 或 RISKY:<类别>。'
      ].join('\n')
      const text = await callFlash(user, SYSTEM_PROMPT, signal)
      const trimmed = text.trim().toUpperCase()
      const riskyMatch = trimmed.match(/RISKY\s*[:：]\s*([A-Z_]+)/)
      if (riskyMatch) {
        const category = riskyMatch[1].toLowerCase()
        return { verdict: 'risky', category }
      }
      // 裸 RISKY（无类别，旧协议残留）→ 按中立处理（有计数/裁决兜底）
      if (trimmed.includes('RISKY')) return { verdict: 'risky', category: 'neutral' }
      if (trimmed.includes('SAFE')) return { verdict: 'safe' }
      throw new Error('flash 输出无法解析: ' + JSON.stringify(text.slice(0, 120)))
    }

    const SIMILARITY_PROMPT = [
      '你是操作意图一致性判断器。用户已人工批准过一些操作（同一工具、同一沙箱模式的例行操作），现在要判断一个新请求是否属于同类。',
      '',
      '你将收到：',
      '- 用户已批准的操作样本（每个样本包含操作背景和目的）',
      '- 一个新操作的背景和目的',
      '',
      '判断规则：',
      '- SAME：新操作与某个样本属于同类操作——操作对象（同一文件/目录/项目/配置/系统）或目的（同一类例行维护、同一次任务的延续）一致或高度相似',
      '- DIFFERENT：新操作的操作对象或目的与所有样本明显不同（不同文件/不同系统/不同性质的操作）',
      '',
      '只输出一个词：SAME 或 DIFFERENT。拿不准时输出 DIFFERENT。不要输出任何其他内容。'
    ].join('\n')

    /**
     * 单次「第三方同类验证」：把本次操作的背景和目的 + 用户历史确认样本给 flash，
     * 判断是否属于已确认的同类操作（语义级，不依赖关键词）。
     * @returns {Promise<{verdict:'same'|'different'}>}
     */
    const verifySimilarity = async (toolName, mode, justification, samples, signal) => {
      const sampleLines = samples
        .map((s, i) => `样本${i + 1}: ${s.ctx || s.fp || '(无描述)'}`)
        .join('\n')
      const user = [
        `工具: ${toolName}`,
        `目标沙箱模式: ${mode || '(非越界审批)'}`,
        '',
        '【用户已批准的操作样本】',
        sampleLines || '（无样本）',
        '',
        '【本次新操作】',
        `操作理由: ${justification || '(无说明)'}`,
        '',
        '请判断：新操作是否与某个已批准样本属于同类操作？输出 SAME 或 DIFFERENT。'
      ].join('\n')
      const text = await callFlash(user, SIMILARITY_PROMPT, signal)
      const trimmed = text.trim().toUpperCase()
      if (trimmed.includes('DIFFERENT')) return { verdict: 'different' }
      if (trimmed.includes('SAME')) return { verdict: 'same' }
      throw new Error('同类验证输出无法解析: ' + JSON.stringify(text.slice(0, 120)))
    }

    /**
     * 通用超时 + 重试包装：runFn(signal) 返回结果对象；
     * 超时 abort 并重试 1 次，仍失败 → { failed: true }（调用方按 fail-safe 处理）。
     * judgeOnce / verifySimilarity 共用；rejection 在 race 内消化（防 unhandled rejection）。
     */
    const withRetry = async (runFn, label) => {
      const timeoutMs = config.judgeTimeoutMs || 20000
      const runOnce = async () => {
        const controller = new AbortController()
        const timer = ctx.timeout(timeoutMs).then(() => {
          controller.abort(`dsh-approval-gate: ${label} 超时`)
          return 'timeout'
        })
        try {
          const call = runFn(controller.signal)
            .then((r) => ({ ...r, timedOut: false }))
            .catch((error) => ({ judgeError: error }))
          const result = await Promise.race([call, timer.then(() => ({ timedOut: true }))])
          if (result.judgeError) throw result.judgeError
          return result
        } finally {
          controller.abort(`dsh-approval-gate: ${label} 结束`)
        }
      }

      try {
        const first = await runOnce()
        if (!first.timedOut) return first
        console.warn(`[${NAME}] ${label} 超时(${timeoutMs}ms)，重试 1 次`)
      } catch (error) {
        console.error(`[${NAME}] ${label} 异常，重试 1 次`, error)
      }
      try {
        const second = await runOnce()
        if (!second.timedOut) return second
      } catch (error) {
        console.error(`[${NAME}] ${label} 重试仍异常`, error)
        return { failed: true }
      }
      console.warn(`[${NAME}] ${label} 两次超时(${timeoutMs}ms×2)`)
      return { failed: true }
    }

    /** flash 风险判定（带超时重试）：失败 → { verdict:'risky', category:'neutral', failed:true }（fail-safe） */
    const judgeWithFlash = async (toolName, mode, justification) => {
      const result = await withRetry((signal) => judgeOnce(toolName, mode, justification, signal), 'flash 判断')
      if (result.failed) return { verdict: 'risky', category: 'neutral', timedOut: true, failed: true }
      return result
    }

    /** 同类验证（带超时重试）：失败 → { verdict:'different', failed:true }（fail-safe：验证失败按不同类处理） */
    const verifySimilarityWithRetry = async (toolName, mode, justification, samples) => {
      const result = await withRetry((signal) => verifySimilarity(toolName, mode, justification, samples, signal), '同类验证')
      if (result.failed) return { verdict: 'different', failed: true }
      return result
    }

    /** 记录一次人工批准的样本（{fp, ctx}）；同指纹覆盖旧样本；返回本次指纹（可能为 null） */
    const recordSample = (key, justification) => {
      const fp = extractOperationFingerprint(justification)
      const ctx = String(justification || '').slice(0, 200)
      const list = (learning.history[key] || []).slice()
      const idx = fp ? list.findIndex((s) => s.fp === fp) : -1
      if (idx >= 0) list[idx] = { fp, ctx }
      else list.push({ fp, ctx })
      learning.history[key] = list.slice(-10)
      return fp
    }

    ctx.on('approval/request', async (req, next) => {
      try {
        reloadConfig()
        const session = req.agent && req.agent.session
        if (!session) return next()
        let preset
        try {
          preset = permissionPresets.current(session.events)
        } catch (error) {
          console.error(`[${NAME}] permissionPresets.current failed`, error)
          return next()
        }
        if (preset !== PRESET_NAME) return next()
        if (req.signal && req.signal.aborted) return next()

        const toolName = String(req.toolName || 'unknown')
        const reason = String(req.reason || '')
        const { mode, justification } = parseReason(reason)
        const sessionId = typeof session.id === 'string' ? session.id : ''

        // 1. DENY 层：不可逆危险词 → 转人工（fail-safe，最高优先）
        if (looksDeny(toolName + ' ' + reason)) {
          audit(`DENY    ${toolName} mode=${mode || 'none'} | ${reason.slice(0, 160)}`)
          return next()
        }

        // 2. 白名单层：命中规则 → 直接放行（确定性，不过 flash）
        const matchedRule = matchRule(config.allowRules, toolName, mode, null, justification)
        if (matchedRule) {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (rule: ${matchedRule.description || 'matched'})`)
          recordAutoAllow(sessionId, toolName, mode, reason, justification, 'rule')
          return 'allowed-once'
        }

        // 3. flash 判定
        const { verdict, category, timedOut, failed } = await judgeWithFlash(toolName, mode, justification)

        if (verdict === 'safe') {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (flash-safe${timedOut ? '，重试后' : ''})`)
          recordAutoAllow(sessionId, toolName, mode, reason, justification, 'flash-safe')
          return 'allowed-once'
        }

        const cat = category || 'neutral'

        // 4a. flash 完全失败（超时×2/异常×2）→ 转人工（fail-safe：无法判断绝不自动放行）
        if (failed) {
          audit(`FAILED  ${toolName} mode=${mode || 'none'} → 人工 | ${reason.slice(0, 120)}`)
          return next()
        }

        // 4b. 硬风险类别（deletion/credential/remote/system/bulk）→ 直接转人工（必须人工确认，不计数不学习）
        const hard = config.hardCategories || DEFAULT_HARD_CATEGORIES
        if (hard.includes(cat)) {
          audit(`HARD    ${toolName} mode=${mode || 'none'} category=${cat} → 人工 | ${reason.slice(0, 120)}`)
          return next()
        }

        // 4c. 协议外类别（模型输出未知类别）→ 判定不可靠，fail-safe 转人工
        if (cat !== 'neutral') {
          audit(`UNKNOWN ${toolName} mode=${mode || 'none'} category=${cat} → 人工 | ${reason.slice(0, 120)}`)
          return next()
        }

        // 4d. denyRules 命中（此前用户裁决拒绝过的 key）→ 直接转人工（拒绝优先于沉淀）
        if (matchRule(config.denyRules, toolName, mode, cat, justification)) {
          audit(`DENYRULE ${toolName} mode=${mode || 'none'} category=${cat} → 人工 | ${reason.slice(0, 120)}`)
          return next()
        }

        // 4e. 沉淀规则（带 category 的学习规则，用户批准过）→ 直接放行，不再计数
        const key = learnKey(toolName, mode, cat)
        const learnedRule = matchRule(config.allowRules, toolName, mode, cat, justification)
        if (learnedRule) {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (rule: ${learnedRule.description || '沉淀规则'})`)
          delete learning.stats[key]
          saveJson(LEARNING_PATH, learning)
          recordAutoAllow(sessionId, toolName, mode, reason, justification, 'learned')
          return 'allowed-once'
        }

        // 4f. 中立类别（neutral）：前 N-1 次人工确认，第 N 次起自动放行并沉淀
        //     （同一 key 被用户连续确认 N-1 次后视为可信，第 N 次自动放行并写入沉淀规则）
        const threshold = config.riskyThreshold || 3
        const confirmed = learning.stats[key] || 0

        if (confirmed >= threshold - 1) {
          const fingerprint = extractOperationFingerprint(justification)
          const samples = learning.history[key] || []
          const fpHit = Boolean(fingerprint) && samples.some((s) => s.fp === fingerprint)

          if (fpHit) {
            // ① 指纹确定性命中（用户确认过该操作）→ 自动放行 + 沉淀规则
            if (learning.enabled) {
              const rule = { tool: toolName, category: cat, contains: fingerprint }
              if (mode) rule.mode = mode
              if (!config.allowRules.some((r) => r.tool === rule.tool && r.mode === rule.mode && r.category === rule.category && r.contains === rule.contains)) {
                rule.description = `自动沉淀：${cat === 'neutral' ? '中立' : CATEGORY_LABELS[cat] || cat} 人工确认后自动放行`
                config.allowRules.push(rule)
                saveJson(ALLOWLIST_PATH, config)
                audit(`LEARN   ${key} 已沉淀白名单 ${JSON.stringify(rule)}`)
              }
            }
            audit(`ALLOW   ${toolName} mode=${mode || 'none'} (neutral-learned=${confirmed + 1}/${threshold}) | ${reason.slice(0, 100)}`)
            delete learning.stats[key]
            delete learning.history[key]
            saveJson(LEARNING_PATH, learning)
            recordAutoAllow(sessionId, toolName, mode, reason, justification, 'fpHit')
            return 'allowed-once'
          }

          if (samples.length > 0) {
            // 指纹未命中 → flash 第三方同类验证：把本次操作背景 + 用户确认样本给 flash，
            // 语义判断是否属于已确认的同类操作（不依赖关键词）
            const sim = await verifySimilarityWithRetry(toolName, mode, justification, samples)
            if (sim.verdict === 'same') {
              // 判同类 → 自动放行；有指纹则沉淀规则（无指纹不沉淀，保留样本供后续验证）
              if (learning.enabled && fingerprint) {
                const rule = { tool: toolName, category: cat, contains: fingerprint }
                if (mode) rule.mode = mode
                if (!config.allowRules.some((r) => r.tool === rule.tool && r.mode === rule.mode && r.category === rule.category && r.contains === rule.contains)) {
                  rule.description = `自动沉淀：${cat === 'neutral' ? '中立' : CATEGORY_LABELS[cat] || cat} flash 同类验证`
                  config.allowRules.push(rule)
                  saveJson(ALLOWLIST_PATH, config)
                  audit(`LEARN   ${key} flash 判同类，已沉淀白名单 ${JSON.stringify(rule)}`)
                }
                delete learning.stats[key]
                delete learning.history[key]
                saveJson(LEARNING_PATH, learning)
              } else {
                // 无指纹：不沉淀，保留样本与阈值位（下次同操作仍靠 flash 验证放行）
                audit(`SAME    ${toolName} mode=${mode || 'none'} category=${cat} flash 判同类（无指纹，未沉淀）| ${reason.slice(0, 100)}`)
              }
              audit(`ALLOW   ${toolName} mode=${mode || 'none'} (flash-same) | ${reason.slice(0, 100)}`)
              recordAutoAllow(sessionId, toolName, mode, reason, justification, 'flash-same')
              return 'allowed-once'
            }
            // 判 DIFFERENT / 验证失败 → 落人工确认
            audit(`SIMDIFF ${toolName} mode=${mode || 'none'} category=${cat} flash 判不同类 → 人工 | ${reason.slice(0, 120)}`)
          }

          // 指纹未命中（且无样本可验证 / 判不同类）：转人工确认
          audit(`RISKY   ${toolName} mode=${mode || 'none'} category=${cat} confirm=${confirmed + 1}/${threshold}（操作未确认过）→ 人工 outcome=? | ${reason.slice(0, 120)}`)
          const outcome = await next()
          audit(`OUTCOME ${key} outcome=${outcome} | ${reason.slice(0, 80)}`)
          if (outcome === 'allowed-once' && learning.enabled) {
            // 批准 → 记录本次操作样本（背景+指纹）；计数保持阈值位
            recordSample(key, justification)
            saveJson(LEARNING_PATH, learning)
          } else if (outcome === 'rejected') {
            // 拒绝 → 永久人工（带指纹；提取不到则拦全部同类，拒绝从严）
            const rule = { tool: toolName, category: cat }
            if (mode) rule.mode = mode
            if (fingerprint) rule.contains = fingerprint
            if (!config.denyRules.some((r) => r.tool === rule.tool && r.mode === rule.mode && r.category === rule.category && r.contains === rule.contains)) {
              config.denyRules.push(rule)
              saveJson(ALLOWLIST_PATH, config)
              audit(`LEARN   ${key} 被人工拒绝，已升级永久人工 ${JSON.stringify(rule)}`)
            }
            delete learning.stats[key]
            delete learning.history[key]
            saveJson(LEARNING_PATH, learning)
          }
          return outcome
        }

        // 前 N-1 次 → 人工确认
        audit(`RISKY   ${toolName} mode=${mode || 'none'} category=${cat} confirm=${confirmed + 1}/${threshold} → 人工 outcome=? | ${reason.slice(0, 120)}`)
        const outcome = await next()
        audit(`OUTCOME ${key} outcome=${outcome} | ${reason.slice(0, 80)}`)

        if (outcome === 'allowed-once' && learning.enabled) {
          // 批准 → 确认计数 +1，并记录本次操作样本（未达阈值，下次同类仍人工确认）
          learning.stats[key] = confirmed + 1
          recordSample(key, justification)
          saveJson(LEARNING_PATH, learning)
        } else if (outcome === 'rejected') {
          // 拒绝 → 升级为永久人工规则（带操作指纹；提取不到则拦全部同类，拒绝从严）
          const fingerprint = extractOperationFingerprint(justification)
          const rule = { tool: toolName, category: cat }
          if (mode) rule.mode = mode
          if (fingerprint) rule.contains = fingerprint
          if (!config.denyRules.some((r) => r.tool === rule.tool && r.mode === rule.mode && r.category === rule.category && r.contains === rule.contains)) {
            config.denyRules.push(rule)
            saveJson(ALLOWLIST_PATH, config)
            audit(`LEARN   ${key} 被人工拒绝，已升级永久人工 ${JSON.stringify(rule)}`)
          }
          delete learning.stats[key]
          delete learning.history[key]
          saveJson(LEARNING_PATH, learning)
        }
        // cancelled/unavailable：不计数（用户未表态，下次仍人工确认）
        return outcome
      } catch (error) {
        console.error(`[${NAME}] 判断过程出错，回退人工`, error)
        return next()
      }
    }, { prepend: true })

    console.log(`[${NAME}] v3 已挂载：DENY→白名单→denyRules→flash(SAFE/硬类别/中立计数${config.riskyThreshold})→裁决学习（配置: ${ALLOWLIST_PATH}）`)
  },
}
