/**
 * dsh-approval-gate — 自动审批（多级判定）持久插件 v2
 *
 * 挂在审批瀑布（approval/request）最前：当会话权限预设为 auto-approve 时，
 * 按「DENY → 白名单 → flash 兜底 → 人工学习」四级管道判定越界请求。
 *
 * DSH 审批触发点：命令在沙箱内被拒后，模型带 sandbox_permissions 重试，
 * 触发 approval.request，reason 固定为：
 *   `escalate sandbox to <mode>: <justification>`
 * 其中 mode 仅两级：workspace-write（写工作区，可回补）/
 * danger-full-access（任意文件/系统，危险）。
 *
 * 设计（借鉴 Claude Code / Codex 调研）：
 *   1. DENY 层（最高优先）：reason 命中不可逆危险词 → 转人工（fail-safe）
 *   2. 白名单层（确定性，外部配置 allowlist.json）：命中规则 → 直接 allowed-once
 *      - 默认规则 {mode:"workspace-write"}：工作区写入可回补，自动放行
 *        （对应 Claude acceptEdits / Codex workspace-write 哲学）
 *   3. flash 兜底：仅 danger-full-access / 非 escalation 请求走 LLM 多因子判断
 *   4. 人工学习：转人工后被用户批准（next() 返回 allowed-once）≥N 次
 *      → 该「工具+模式」自动沉淀进白名单（danger-full-access 永不自动沉淀）
 *
 * 数据文件（跨部署统一放到 DSH_HOME 下，node_modules 可能只读）：
 *   $DSH_HOME/auto-approve/allowlist.json  配置（denyKeywords / allowRules / learning）
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

const SYSTEM_PROMPT = [
  '你是 AI 编程代理的操作风险评估器。DSH 的审批只发生在「沙箱越界」时，即命令需要比当前更宽的权限才能执行。',
  '',
  '你将收到：工具名、请求升级的目标沙箱模式、以及一句操作理由（justification）。',
  '沙箱模式含义：',
  '- workspace-write：允许写当前工作区（可回补，通常安全）',
  '- danger-full-access：允许写任意文件/系统（不可回补风险高）',
  '',
  '输出规则（只输出一个词 SAFE 或 RISKY）：',
  '- SAFE：操作不会造成不可回补后果，且不触碰敏感资源。例如：',
  '   工作区内常规读写、安装/构建、git 常规操作、可再生的临时数据、可撤销的修改',
  '- RISKY：操作可能造成不可回补后果，或触碰敏感/外部资源。例如：',
  '   删除/覆盖不可再生数据、危险删除命令、格式化、force push、drop table、',
  '   影响远程系统/生产数据库、发送消息/扣费、修改凭据或密钥、批量覆盖大量文件、',
  '   写入工作区之外的系统路径',
  '- 当 mode 为 danger-full-access 时，除非 justification 明确表明是安全的常规操作，否则输出 RISKY',
  '- 只根据 justification 描述判断，不臆测额外风险；信息不足时，若属可回补类操作输出 SAFE，否则 RISKY',
  '',
  '只输出一个词：SAFE 或 RISKY。不要输出任何其他内容。'
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

// 首次加载时初始化配置文件
let config = loadJson(ALLOWLIST_PATH, null)
if (!config || typeof config !== 'object') {
  config = { version: 1, denyKeywords: DEFAULT_DENY_KEYWORDS, allowRules: DEFAULT_ALLOW_RULES }
  saveJson(ALLOWLIST_PATH, config)
} else {
  config.denyKeywords = config.denyKeywords || DEFAULT_DENY_KEYWORDS
  config.allowRules = config.allowRules || DEFAULT_ALLOW_RULES
}

const learning = loadJson(LEARNING_PATH, { enabled: true, threshold: 3, stats: {} })
learning.enabled = learning.enabled !== false
learning.threshold = learning.threshold || 3
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

// 规则匹配：tool / mode / contains 三者均满足（缺省表示任意）
function matchAllow(toolName, mode, justification) {
  const rules = config.allowRules || []
  const j = String(justification || '').toLowerCase()
  for (const rule of rules) {
    if (rule.tool && rule.tool !== toolName) continue
    if (rule.mode && rule.mode !== mode) continue
    if (rule.contains && !j.includes(String(rule.contains).toLowerCase())) continue
    return rule
  }
  return null
}

function learnKey(toolName, mode) {
  return `${toolName}|${mode || 'none'}`
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

    const judgeWithFlash = async (toolName, mode, justification) => {
      const { provider, model } = resolveModel()
      const user = [
        `工具: ${toolName}`,
        `目标沙箱模式: ${mode || '(非越界审批)'}`,
        `操作理由: ${justification || '(无说明)'}`,
        '',
        '请判断：执行该操作是否会造成无法回补的后果或触碰敏感资源？'
      ].join('\n')

      let text = ''
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        system: SYSTEM_PROMPT,
        temperature: 0,
        reasoningEffort: 'off',
        maxTokens: 64
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : chunk.reason.kind
          throw new Error('flash 判断调用失败: ' + failure)
        }
      }
      const verdict = text.trim().toUpperCase()
      if (verdict.includes('RISKY')) return 'risky'
      if (verdict.includes('SAFE')) return 'safe'
      return 'risky'
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

        // 1. DENY 层：不可逆危险词 → 转人工（fail-safe）
        if (looksDeny(toolName + ' ' + reason)) {
          audit(`DENY    ${toolName} mode=${mode || 'none'} | ${reason.slice(0, 160)}`)
          return next()
        }

        // 2. 白名单层：命中规则 → 直接放行（确定性，不过 flash）
        const matchedRule = matchAllow(toolName, mode, justification)
        if (matchedRule) {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (rule: ${matchedRule.description || 'matched'})`)
          return 'allowed-once'
        }

        // 3. flash 兜底：仅 danger-full-access / 非 escalation 请求
        const verdict = await Promise.race([
          judgeWithFlash(toolName, mode, justification).catch((error) => {
            console.error(`[${NAME}] flash 判断异常，转人工`, error)
            return 'risky'
          }),
          ctx.timeout(20000).then(() => {
            console.warn(`[${NAME}] flash 判断超时(20s)，转人工`)
            return 'risky'
          })
        ])
        if (verdict === 'safe') {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} (flash)`)
          return 'allowed-once'
        }

        // 4. RISKY → 转人工，并做学习沉淀
        const outcome = await next()
        audit(`RISKY   ${toolName} mode=${mode || 'none'} → 人工 outcome=${outcome} | ${reason.slice(0, 120)}`)
        if (outcome === 'allowed-once' && learning.enabled) {
          // 仅明确的非 danger 模式才学习沉淀；mode 为空（非越界审批）不沉淀，
          // 避免生成裸 {tool} 规则导致 danger-full-access 被误放行
          if (mode && mode !== 'danger-full-access') {
            const key = learnKey(toolName, mode)
            learning.stats[key] = (learning.stats[key] || 0) + 1
            if (learning.stats[key] >= learning.threshold) {
              const rule = { tool: toolName }
              if (mode) rule.mode = mode
              // 去重后写入白名单
              if (!config.allowRules.some((r) => r.tool === rule.tool && r.mode === rule.mode)) {
                config.allowRules.push(rule)
                saveJson(ALLOWLIST_PATH, config)
                audit(`LEARN   ${key} 达阈值 ${learning.threshold}，已沉淀白名单`)
              }
              delete learning.stats[key]
            }
            saveJson(LEARNING_PATH, learning)
          }
        }
        return outcome
      } catch (error) {
        console.error(`[${NAME}] 判断过程出错，回退人工`, error)
        return next()
      }
    }, { prepend: true })

    console.log(`[${NAME}] v2 已挂载：多级判定 deny→白名单→flash→学习（配置: ${ALLOWLIST_PATH}）`)
  },
}
