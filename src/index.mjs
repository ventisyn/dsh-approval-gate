/**
 * dsh-approval-gate — 自动审批（Flash 风险判断）持久插件
 *
 * 挂在审批瀑布（approval/request）最前：当会话的权限预设为
 * auto-approve 时，用 flash 模型预判即将执行的操作（写入/命令升级）
 * 是否会造成「无法回补」的后果：
 *   - 可回补（SAFE）→ 返回 'allowed-once' 自动批准（不弹窗）
 *   - 不可回补/不确定（RISKY）→ 调用 next() 转人工审批（fail-safe）
 *
 * 门控：permissionPresets.current(session) === 'auto-approve'
 * 即权限下拉菜单选中「自动审批（Flash）」的会话才启用本判断。
 */
const NAME = 'dsh-approval-gate'

const IRREVERSIBLE_KEYWORDS = [
  'rm -rf', 'rm -fr', 'rm -r -f', 'rm --recursive --force',
  'push --force', 'force-push', 'drop table', 'drop database',
  'mkfs', 'mkfs.ext', 'format', 'shutdown', 'reboot', 'dd of=',
  'delete from', 'truncate table', 'terraform destroy', 'revoke',
  '清空数据库', '删除数据库', '格式化', 'sudo rm', 'chmod 777 /'
]

const SYSTEM_PROMPT = [
  '你是 AI 编程代理的操作风险评估器。判断一次即将执行的操作是否会造成【无法回补（不可逆、无法撤销/无法恢复）】的后果。',
  '',
  '输出规则：',
  '- 若操作不会造成无法回补的后果（例如：工作区内创建/修改常规文件、可再生的临时数据、可撤销的常规命令）→ 输出 SAFE',
  '- 若操作可能造成无法回补的后果（例如：删除/覆盖不可再生数据、rm -rf、格式化、force push、drop table、影响远程系统/数据库、发送消息/扣费、修改凭据或密钥、批量覆盖大量文件）→ 输出 RISKY',
  '- 不确定时输出 RISKY（保守）。',
  '',
  '只输出一个词：SAFE 或 RISKY。不要输出任何其他内容。'
].join('\n')

function looksIrreversible(text) {
  const lower = String(text || '').toLowerCase()
  return IRREVERSIBLE_KEYWORDS.some((keyword) => lower.includes(keyword))
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

    // flash 判断：关闭推理 + 充足 token；只认可 SAFE/RISKY 明确输出
    const judgeWithFlash = async (toolName, reason) => {
      const { provider, model } = resolveModel()
      const user = `工具: ${toolName}\n操作说明/理由: ${reason || '(无说明)'}\n\n请判断：执行该操作是否会造成无法回补的后果？`

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

    // 审批瀑布钩子：prepend 保证先于 web answerer 接单
    ctx.on('approval/request', async (req, next) => {
      try {
        // 门控：仅当该会话的权限预设是 auto-approve 时介入
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
        const combined = toolName + ' ' + reason

        let verdict
        let source
        if (looksIrreversible(combined)) {
          verdict = 'risky'
          source = 'keyword'
        } else {
          verdict = await Promise.race([
            judgeWithFlash(toolName, reason).catch((error) => {
              console.error(`[${NAME}] flash 判断异常，转人工`, error)
              return 'risky'
            }),
            ctx.timeout(20000).then(() => {
              console.warn(`[${NAME}] flash 判断超时(20s)，转人工`)
              return 'risky'
            })
          ])
          source = 'flash'
        }

        if (verdict === 'safe') {
          console.log(`[${NAME}] SAFE(${source}) → 自动批准 ${toolName}: ${reason.slice(0, 120)}`)
          return 'allowed-once'
        }
        console.log(`[${NAME}] RISKY(${source}) → 转人工审批 ${toolName}: ${reason.slice(0, 120)}`)
        return next()
      } catch (error) {
        console.error(`[${NAME}] 判断过程出错，回退到人工审批`, error)
        return next()
      }
    }, { prepend: true })

    console.log(`[${NAME}] 已挂载：权限预设为「${PRESET_NAME}」的会话将启用 flash 自动审批`)
  },
}
