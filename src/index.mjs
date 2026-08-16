/**
 * dsh-approval-gate — 自动审批（多级判定）持久插件 v3
 *
 * 挂在审批瀑布（approval/request）最前：当会话权限预设为 auto-approve 时，
 * 按「DENY → 白名单 → denyRules → flash（SAFE/硬类别/中立计数）→ 裁决学习」管道判定越界请求。
 *
 * 设计目标：最小人工介入。人工只出现在两类场景：
 *   1. 必须人工确认：DENY 危险词、硬风险类别（deletion/credential/remote/system/bulk）
 *   2. 中立操作（neutral）：前 N-1 次人工确认，第 N 次起自动放行并沉淀为规则：
 *      批准 → 计数，确认达 N-1 次后同类操作自动放行（沉淀 {tool,mode,category} 规则）
 *      拒绝 → 升级为永久人工规则（denyRules），以后同类直接转人工
 *      取消 → 不计数（用户未表态，下次仍人工确认）
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
  config.denyKeywords = config.denyKeywords || DEFAULT_DENY_KEYWORDS
  config.allowRules = config.allowRules || DEFAULT_ALLOW_RULES
  config.denyRules = config.denyRules || []
  config.hardCategories = config.hardCategories || DEFAULT_HARD_CATEGORIES
  config.riskyThreshold = config.riskyThreshold || 3
  config.judgeTimeoutMs = config.judgeTimeoutMs || 20000
  config.learning = config.learning || { enabled: true }
  if (config.version !== 3) { config.version = 3; saveJson(ALLOWLIST_PATH, config) }
}

const learning = loadJson(LEARNING_PATH, { enabled: true, stats: {} })
// enabled 以 allowlist.json 的 learning 段为单一配置源（旧 learning.json 的 enabled 仅作兼容回退）
learning.enabled = config.learning ? config.learning.enabled !== false : learning.enabled !== false
learning.stats = learning.stats || {}

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

export default {
  name: NAME,
  inject: ['llm', 'approval', 'permissionPresets', 'agentDefaultModel', 'timer'],
  apply(ctx) {
    const llm = ctx.llm
    const permissionPresets = ctx.permissionPresets
    const agentDefaultModel = ctx.get('agentDefaultModel')
    const PRESET_NAME = 'auto-approve'

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
     * 单次 flash 判定：输出 SAFE 或 RISKY:<category>。
     * signal 可取消（超时 abort）；异常/超时向上抛，由调用方决定重试或转人工。
     * @returns {Promise<{verdict:'safe'|'risky', category?:string}>}
     */
    const judgeOnce = async (toolName, mode, justification, signal) => {
      const { provider, model } = resolveModel()
      const user = [
        `工具: ${toolName}`,
        `目标沙箱模式: ${mode || '(非越界审批)'}`,
        `操作理由: ${justification || '(无说明)'}`,
        '',
        '请判断：执行该操作是否会造成无法回补的后果或触碰敏感资源？输出 SAFE 或 RISKY:<类别>。'
      ].join('\n')

      let text = ''
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        system: SYSTEM_PROMPT,
        temperature: 0,
        reasoningEffort: 'off',
        maxTokens: 64,
        signal
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : chunk.reason.kind
          throw new Error('flash 判断调用失败: ' + failure)
        }
      }
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

    /**
     * flash 判定（带超时 + 1 次重试）。
     * @returns {Promise<{verdict:'safe'|'risky', category?:string, timedOut?:boolean, failed?:boolean}>}
     *   两次尝试均超时/失败 → 返回 { verdict:'risky', category:'neutral', timedOut:true, failed:true }
     *   （fail-safe：按中立计数处理，不会自动放行硬风险，也不会无限重试）
     */
    const judgeWithFlash = async (toolName, mode, justification) => {
      const timeoutMs = config.judgeTimeoutMs || 20000
      const runOnce = async () => {
        const controller = new AbortController()
        const timer = ctx.timeout(timeoutMs).then(() => {
          controller.abort('dsh-approval-gate: flash 判断超时')
          return 'timeout'
        })
        try {
          // judgeOnce 的 rejection 在这里消化：race 被 timer 先 settle 后，
          // abort 引发的流错误（ABORTED）不能变成 unhandled rejection（Node strict 模式会崩进程）
          const judge = judgeOnce(toolName, mode, justification, controller.signal)
            .then((r) => ({ ...r, timedOut: false }))
            .catch((error) => ({ judgeError: error }))
          const result = await Promise.race([judge, timer.then(() => ({ timedOut: true }))])
          if (result.judgeError) throw result.judgeError
          return result
        } finally {
          controller.abort('dsh-approval-gate: flash 判断结束')
        }
      }

      try {
        const first = await runOnce()
        if (!first.timedOut) return first
        console.warn(`[${NAME}] flash 判断超时(${timeoutMs}ms)，重试 1 次`)
      } catch (error) {
        console.error(`[${NAME}] flash 判断异常，重试 1 次`, error)
      }
      try {
        const second = await runOnce()
        if (!second.timedOut) return second
      } catch (error) {
        console.error(`[${NAME}] flash 判断重试仍异常，转人工`, error)
        return { verdict: 'risky', category: 'neutral', timedOut: true, failed: true }
      }
      console.warn(`[${NAME}] flash 判断两次超时(${timeoutMs}ms×2)，转人工`)
      return { verdict: 'risky', category: 'neutral', timedOut: true, failed: true }
    }

    ctx.on('approval/request', async (req, next) => {
      try {
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

        // 1. DENY 层：不可逆危险词 → 转人工（fail-safe，最高优先）
        if (looksDeny(toolName + ' ' + reason)) {
          audit(`DENY    ${toolName} mode=${mode || 'none'} | ${reason.slice(0, 160)}`)
          return next()
        }

        // 2. 白名单层：命中规则 → 直接放行（确定性，不过 flash）
        const matchedRule = matchRule(config.allowRules, toolName, mode, null, justification)
        if (matchedRule) {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (rule: ${matchedRule.description || 'matched'})`)
          return 'allowed-once'
        }

        // 3. flash 判定
        const { verdict, category, timedOut, failed } = await judgeWithFlash(toolName, mode, justification)

        if (verdict === 'safe') {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (flash-safe${timedOut ? '，重试后' : ''})`)
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
          return 'allowed-once'
        }

        // 4f. 中立类别（neutral）：前 N-1 次人工确认，第 N 次起自动放行并沉淀
        //     （同一 key 被用户连续确认 N-1 次后视为可信，第 N 次自动放行并写入沉淀规则）
        const threshold = config.riskyThreshold || 3
        const confirmed = learning.stats[key] || 0

        if (confirmed >= threshold - 1) {
          // 已确认 N-1 次 → 第 N 次自动放行 + 沉淀规则
          if (learning.enabled) {
            const rule = { tool: toolName, category: cat }
            if (mode) rule.mode = mode
            if (!config.allowRules.some((r) => r.tool === rule.tool && r.mode === rule.mode && r.category === rule.category)) {
              rule.description = `自动沉淀：${cat === 'neutral' ? '中立' : CATEGORY_LABELS[cat] || cat} 连续人工确认 ${threshold - 1} 次`
              config.allowRules.push(rule)
              saveJson(ALLOWLIST_PATH, config)
              audit(`LEARN   ${key} 人工确认 ${confirmed} 次达阈值，已沉淀白名单 ${JSON.stringify(rule)}`)
            }
          }
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (neutral-learned=${confirmed + 1}/${threshold}) | ${reason.slice(0, 100)}`)
          delete learning.stats[key]
          saveJson(LEARNING_PATH, learning)
          return 'allowed-once'
        }

        // 前 N-1 次 → 人工确认
        audit(`RISKY   ${toolName} mode=${mode || 'none'} category=${cat} confirm=${confirmed + 1}/${threshold} → 人工 outcome=? | ${reason.slice(0, 120)}`)
        const outcome = await next()
        audit(`OUTCOME ${key} outcome=${outcome} | ${reason.slice(0, 80)}`)

        if (outcome === 'allowed-once' && learning.enabled) {
          // 批准 → 确认计数 +1（未达阈值，下次同类仍人工确认）
          learning.stats[key] = confirmed + 1
          saveJson(LEARNING_PATH, learning)
        } else if (outcome === 'rejected') {
          // 拒绝 → 升级为永久人工规则
          const rule = { tool: toolName, category: cat }
          if (mode) rule.mode = mode
          if (!config.denyRules.some((r) => r.tool === rule.tool && r.mode === rule.mode && r.category === rule.category)) {
            config.denyRules.push(rule)
            saveJson(ALLOWLIST_PATH, config)
            audit(`LEARN   ${key} 被人工拒绝，已升级永久人工 ${JSON.stringify(rule)}`)
          }
          delete learning.stats[key]
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
