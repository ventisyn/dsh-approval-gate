/**
 * dsh-approval-gate — 自动审批审查界面（浏览器端 bundle）
 *
 * 提供两处 UI（严格按 DSH 设计语言，--dsw-alias-* tokens）：
 * 1. ✅ 自动放行提示条：conversation.input.dock（输入框上方独立行，order=30，
 *    排在 todo/goal/queue 之下；无事件时完全隐藏不占位；不随流式对话滚动）
 * 2. 「审批」历史视图：conversation.view（order=20，chat=0/trajectory=10 →
 *    tab 显示在「轨迹」右侧），展示当前会话所有自动放行的动作时间线
 *    （命令、原因、涉及文件、判定路径、时间）
 *
 * 数据源：轮询 host 提供的 GET /api/auto-approve/events?sessionId=&since=
 * （events.jsonl 由 host 插件在每次自动放行时追加）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS = `
.ag-notice{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none}
.ag-notice-card{box-sizing:border-box;display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:6px 10px 6px 12px;box-shadow:var(--dsw-shadow-lv1)}
.ag-notice-glyph{color:var(--dsw-alias-state-success-primary);flex:none;display:inline-flex;align-items:center;justify-content:center}
.ag-notice-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.ag-notice-head{display:flex;align-items:center;gap:8px;min-width:0}
.ag-notice-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}
.ag-notice-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ag-notice-meta{display:flex;align-items:center;gap:8px}
.ag-tag{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ag-tag-neutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ag-time{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.ag-notice-close{width:24px;height:24px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;padding:0}
.ag-notice-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ag-view{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.ag-view-head{box-sizing:border-box;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 14px 8px;display:flex;flex-direction:column;gap:2px}
.ag-view-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.ag-view-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ag-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 14px 16px;display:flex;flex-direction:column;gap:2px}
.ag-row{box-sizing:border-box;display:flex;gap:10px;padding:9px 10px;border-radius:10px;transition:background .1s ease}
.ag-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ag-row-rail{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:2px}
.ag-row-glyph{color:var(--dsw-alias-state-success-primary);flex:none;display:inline-flex}
.ag-row-line{flex:1 1 auto;flex:none;width:1px;background:var(--dsw-alias-border-l1);min-height:10px}
.ag-row:last-child .ag-row-line{display:none}
.ag-row-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.ag-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.ag-row-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}
.ag-row-reason{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all;white-space:pre-wrap}
.ag-row-files{display:flex;flex-wrap:wrap;gap:4px}
.ag-file-chip{box-sizing:border-box;max-width:260px;height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;align-items:center;padding:0 7px;font:11px/18px var(--ds-font-family-code);display:inline-flex;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ag-empty{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px}
.ag-loading{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px}
.ag-mono{font-family:var(--ds-font-family-code)}
.ag-set{box-sizing:border-box;width:100%;max-width:760px;padding:16px 18px 28px;display:flex;flex-direction:column;gap:14px}
.ag-set-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.ag-set-card-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;display:flex;align-items:center;gap:8px}
.ag-set-card-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ag-set-note{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
.ag-set-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.ag-set-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.ag-set-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ag-set-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:28px;min-width:0;color:var(--dsw-alias-label-primary);border-radius:7px;outline:none;padding:0 8px;font-size:12px;line-height:18px;font-family:var(--ds-font-family-code)}
.ag-set-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.ag-set-input::placeholder{color:var(--dsw-alias-label-caption)}
.ag-set-input-num{width:90px}
.ag-set-btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;align-items:center;gap:4px;padding:0 12px;font-size:12px;line-height:18px;display:inline-flex;white-space:nowrap}
.ag-set-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.ag-set-btn:disabled{opacity:.4;cursor:default}
.ag-set-btn-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.ag-set-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ag-set-btn-danger{color:var(--dsw-alias-state-error-primary)}
.ag-set-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.ag-set-list{display:flex;flex-direction:column;gap:6px}
.ag-set-item{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:6px 10px;min-width:0}
.ag-set-item-label{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code);word-break:break-all}
.ag-set-item-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.ag-set-item-del{flex:none;width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;padding:0}
.ag-set-item-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.ag-set-empty{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;padding:4px 2px}
.ag-set-tag{box-sizing:border-box;flex:none;height:18px;border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ag-set-tag-blue{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.ag-set-tag-green{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.ag-set-tag-gray{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ag-set-tag-red{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.ag-set-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.ag-set-hc{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;color:var(--dsw-alias-label-secondary);align-items:center;justify-content:center;gap:6px;height:30px;font-size:12px;line-height:18px;display:inline-flex}
.ag-set-learn{display:flex;flex-direction:column;gap:6px}
.ag-set-learn-item{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code);word-break:break-all}
.ag-set-learn-key{flex:none;color:var(--dsw-alias-label-tertiary)}
`

    const VERDICT_LABELS = {
      rule: '白名单规则',
      'flash-safe': 'Flash 判定安全',
      learned: '沉淀规则',
      fpHit: '已确认操作',
      'flash-same': 'Flash 同类验证'
    }
    const VERDICT_NEUTRAL = new Set(['rule', 'learned', 'fpHit', 'flash-same'])

    function fmtTime(iso) {
      try {
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      } catch (e) { return String(iso || '') }
    }

    function GlyphCheck() {
      return React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        React.createElement('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--dsw-alias-state-success-tertiary)' }),
        React.createElement('path', { d: 'M5 8.3L7.1 10.4L11 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function resolveFrame(sp) {
      let sessionId = (sp && sp.sessionId) || null
      try {
        if (!sessionId && sp && typeof sp.useSessions === 'function') {
          const state = sp.useSessions(function (s) { return s })
          sessionId = (state && state.current) || null
        }
      } catch (e) {}
      return { sessionId }
    }

    function fetchEvents(sessionId, since) {
      const q = '/api/auto-approve/events?sessionId=' + encodeURIComponent(sessionId || '') + (since ? '&since=' + since : '')
      return fetch(q, { headers: { 'cache-control': 'no-cache' } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      }).then(function (data) {
        return (data && Array.isArray(data.events)) ? data.events : []
      })
    }

    // ================= ✅ 自动放行提示条（conversation.input.dock，order=30） =================
    function NoticeStrip(props) {
      const frame = resolveFrame(props.slotsProps || {})
      const sessionId = frame.sessionId
      const [notice, setNotice] = React.useState(null)
      const sinceRef = React.useRef(0)
      const hideTimerRef = React.useRef(null)

      React.useEffect(function () {
        sinceRef.current = 0
        setNotice(null)
        if (!sessionId) return
        // 打开会话：先静默拉一次全量，仅把游标推进到最新，不弹任何历史提示
        fetchEvents(sessionId, 0).then(function (evs) {
          if (evs.length > 0) sinceRef.current = evs[evs.length - 1].id
        }).catch(function () {})
        const timer = setInterval(function () {
          fetchEvents(sessionId, sinceRef.current).then(function (evs) {
            if (evs.length === 0) return
            const last = evs[evs.length - 1]
            sinceRef.current = last.id
            setNotice(last)
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
            hideTimerRef.current = setTimeout(function () { setNotice(null) }, 8000)
          }).catch(function () {})
        }, 2000)
        return function () {
          clearInterval(timer)
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        }
      }, [sessionId])

      if (!notice) return null
      const label = VERDICT_LABELS[notice.verdict] || notice.verdict || '自动放行'
      return React.createElement('div', { className: 'ag-notice' },
        React.createElement('div', { className: 'ag-notice-card' },
          React.createElement('span', { className: 'ag-notice-glyph' }, React.createElement(GlyphCheck, null)),
          React.createElement('div', { className: 'ag-notice-body' },
            React.createElement('div', { className: 'ag-notice-head' },
              React.createElement('span', { className: 'ag-notice-tool' }, notice.tool || 'tool'),
              React.createElement('span', { className: 'ag-notice-text' }, notice.justification || notice.reason || ''),
            ),
            React.createElement('div', { className: 'ag-notice-meta' },
              React.createElement('span', { className: 'ag-tag' + (VERDICT_NEUTRAL.has(notice.verdict) ? ' ag-tag-neutral' : '') }, '自动放行 · ' + label),
              React.createElement('span', { className: 'ag-time' }, fmtTime(notice.ts)),
            ),
          ),
          React.createElement('button', {
            type: 'button',
            className: 'ag-notice-close',
            title: '关闭提示',
            'aria-label': '关闭提示',
            onClick: function () { setNotice(null) },
          }, '✕'),
        ),
      )
    }

    // ================= 审批历史视图（conversation.view，order=20，轨迹右侧） =================
    function HistoryView(props) {
      const sessionId = (props && (props.sessionId || (props.slotsProps && props.slotsProps.sessionId))) || null
      const [events, setEvents] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(function () {
        setEvents(null)
        setError(null)
        if (!sessionId) { setEvents([]); return }
        let alive = true
        const load = function () {
          fetchEvents(sessionId, 0).then(function (evs) {
            if (!alive) return
            evs.sort(function (a, b) { return b.id - a.id }) // 时间倒序：最新在最上面
            setEvents(evs)
            setError(null)
          }).catch(function (e) {
            if (!alive) return
            setError(String((e && e.message) || e))
          })
        }
        load()
        const timer = setInterval(load, 5000)
        return function () { alive = false; clearInterval(timer) }
      }, [sessionId])

      return React.createElement('div', { className: 'ag-view' },
        React.createElement('div', { className: 'ag-view-head' },
          React.createElement('div', { className: 'ag-view-title' }, '自动放行审批'),
          React.createElement('div', { className: 'ag-view-sub' }, '本会话中因自动审批模式而自动放行的动作（按时间线性排布）'),
        ),
        events === null
          ? React.createElement('div', { className: 'ag-loading' }, '加载中…')
          : events.length === 0
            ? React.createElement('div', { className: 'ag-empty' }, error ? ('加载失败：' + error) : '本会话暂无自动放行记录')
            : React.createElement('div', { className: 'ag-list' },
                events.map(function (ev) {
                  const label = VERDICT_LABELS[ev.verdict] || ev.verdict || '自动放行'
                  const files = Array.isArray(ev.files) ? ev.files : []
                  return React.createElement('div', { className: 'ag-row', key: ev.id },
                    React.createElement('div', { className: 'ag-row-rail' },
                      React.createElement('span', { className: 'ag-row-glyph' }, React.createElement(GlyphCheck, null)),
                      React.createElement('span', { className: 'ag-row-line' }),
                    ),
                    React.createElement('div', { className: 'ag-row-body' },
                      React.createElement('div', { className: 'ag-row-top' },
                        React.createElement('span', { className: 'ag-row-tool' }, ev.tool || 'tool'),
                        React.createElement('span', { className: 'ag-tag' + (VERDICT_NEUTRAL.has(ev.verdict) ? ' ag-tag-neutral' : '') }, label),
                        React.createElement('span', { className: 'ag-time' }, fmtTime(ev.ts)),
                      ),
                      React.createElement('div', { className: 'ag-row-reason' }, ev.justification || ev.reason || '(无说明)'),
                      files.length > 0
                        ? React.createElement('div', { className: 'ag-row-files' },
                            files.map(function (f, i) { return React.createElement('span', { className: 'ag-file-chip', key: i }, f) }),
                          )
                        : null,
                    ),
                  )
                }),
              ),
      )
    }

    // ================= 设置页：自动审批规则管理（settings.section） =================
    const RULE_SOURCE_TAGS = {
      default: React.createElement('span', { className: 'ag-set-tag ag-set-tag-blue' }, '预置'),
      learned: React.createElement('span', { className: 'ag-set-tag ag-set-tag-green' }, '学习沉淀'),
      user: React.createElement('span', { className: 'ag-set-tag ag-set-tag-gray' }, '用户'),
    }
    function ruleSource(rule) {
      const d = String(rule && rule.description || '')
      if (d.indexOf('自动沉淀') === 0 || d.indexOf('人工确认后') >= 0 || d.indexOf('flash 同类') >= 0) return 'learned'
      if (d === '用户自定义') return 'user'
      return 'default'
    }

    function RulesSettings(props) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [feedback, setFeedback] = React.useState(null)
      const [newKeyword, setNewKeyword] = React.useState('')
      const [newRule, setNewRule] = React.useState({ tool: '', mode: '', category: '', contains: '' })
      const [threshold, setThreshold] = React.useState('3')
      const [timeoutMs, setTimeoutMs] = React.useState('20000')

      const load = function () {
        fetch('/api/auto-approve/rules', { headers: { 'cache-control': 'no-cache' } })
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data && data.config) {
              setSnapshot(data)
              setThreshold(String(data.config.riskyThreshold))
              setTimeoutMs(String(data.config.judgeTimeoutMs))
              setError(null)
            } else {
              setError('加载规则失败：' + JSON.stringify(data).slice(0, 200))
            }
          })
          .catch(function (e) { setError('加载规则失败：' + String((e && e.message) || e)) })
      }
      React.useEffect(function () { load() }, [])

      const showFeedback = function (msg, ok) {
        setFeedback({ msg: String(msg), ok: ok !== false })
        setTimeout(function () { setFeedback(null) }, 4000)
      }

      const api = function (body) {
        setBusy(true)
        return fetch('/api/auto-approve/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) { load(); showFeedback('已生效（热更新，无需重启）'); return res }
          showFeedback((res && res.error) || '操作失败', false)
          return res
        }).catch(function (e) {
          showFeedback('请求失败：' + String((e && e.message) || e), false)
        }).finally(function () { setBusy(false) })
      }

      const setupNow = function () {
        setBusy(true)
        fetch('/api/auto-approve/setup', { method: 'POST' })
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (res && res.ok) {
              if (res.status === 'already') showFeedback('权限预设已配置，无需操作')
              else showFeedback('已写入 cordis.patch.yml，请重启 dsh web 生效（status=' + res.status + '）')
            } else {
              showFeedback((res && res.error) || '初始化失败', false)
            }
            load()
          })
          .catch(function (e) { showFeedback('初始化请求失败：' + String((e && e.message) || e), false) })
          .finally(function () { setBusy(false) })
      }

      if (!snapshot) {
        return React.createElement('div', { className: 'ag-set' },
          React.createElement('div', { className: error ? 'ag-set-err' : 'ag-set-ok' }, error || '加载中…'))
      }

      const cfg = snapshot.config
      const setup = snapshot.setup || { configured: false }
      const predefined = snapshot.predefined || {}
      const preDeny = new Set(predefined.denyKeywords || [])
      const preAllow = (predefined.allowRules || []).map(function (r) { return JSON.stringify(r) })
      const preHard = new Set(predefined.hardCategories || [])
      const learnStats = snapshot.learning && snapshot.learning.stats ? snapshot.learning.stats : {}
      const learnHistory = snapshot.learning && snapshot.learning.history ? snapshot.learning.history : {}
      const statKeys = Object.keys(learnStats)
      const histKeys = Object.keys(learnHistory)

      return React.createElement('div', { className: 'ag-set' },

        // ---- 初始化卡片 ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '初始化权限预设'),
          React.createElement('div', { className: 'ag-set-card-sub' },
            '安装后需在 profile 的 cordis.patch.yml 添加 auto-approve 权限预设（预设表在配置构造时冻结，无法自动扩展）。' +
            (setup.configured ? '当前已配置 ✓' : '当前未检测到，可一键写入。')),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('button', {
              type: 'button',
              className: 'ag-set-btn' + (setup.configured ? '' : ' ag-set-btn-primary'),
              disabled: busy,
              onClick: setupNow,
            }, setup.configured ? '重新检查' : '一键配置权限预设'),
            !setup.configured ? React.createElement('span', { className: 'ag-set-note' }, '写入后需重启 dsh web 生效') : null,
          ),
        ),

        // ---- 管道总览 ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '当前判定管道'),
          React.createElement('div', { className: 'ag-set-card-sub' },
            'DENY 危险词 → 白名单 → denyRules（拒绝升级）→ Flash 判定（SAFE / 硬类别 / 中立确认）→ 学习沉淀'),
          React.createElement('div', { className: 'ag-set-card-sub' },
            '硬风险类别（命中即转人工，不计数不学习）：'),
          React.createElement('div', { className: 'ag-set-grid' },
            (cfg.hardCategories || []).map(function (c) {
              const isPre = preHard.has(c)
              return React.createElement('span', { className: 'ag-set-hc', key: c },
                c + (isPre ? '' : ' · 自定义'))
            })),
        ),

        // ---- 黑名单（denyKeywords） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '黑名单 · 不可逆危险词'),
          React.createElement('div', { className: 'ag-set-card-sub' }, '命中即转人工（fail-safe，最高优先）；删除预置危险词有风险，请谨慎。'),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('input', {
              className: 'ag-set-input', value: newKeyword, placeholder: '输入危险词，如 sudo rm',
              onChange: function (e) { setNewKeyword(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && newKeyword.trim()) { api({ op: 'add', kind: 'denyKeywords', value: newKeyword.trim() }); setNewKeyword('') } },
            }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn', disabled: busy || !newKeyword.trim(),
              onClick: function () { api({ op: 'add', kind: 'denyKeywords', value: newKeyword.trim() }); setNewKeyword('') },
            }, '添加'),
          ),
          (cfg.denyKeywords || []).length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '无黑名单词')
            : React.createElement('div', { className: 'ag-set-list' },
                cfg.denyKeywords.map(function (kw) {
                  return React.createElement('div', { className: 'ag-set-item', key: kw },
                    React.createElement('span', { className: 'ag-set-item-label' }, kw),
                    preDeny.has(kw)
                      ? React.createElement('span', { className: 'ag-set-item-meta' }, '预置')
                      : null,
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-item-del', title: '删除', 'aria-label': '删除 ' + kw,
                      onClick: function () {
                        if (preDeny.has(kw) && !window.confirm('删除预置危险词「' + kw + '」会降低安全性，确定？')) return
                        api({ op: 'remove', kind: 'denyKeywords', value: kw })
                      },
                    }, '✕'),
                  )
                }),
              ),
        ),

        // ---- 白名单（allowRules） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '白名单 · 自动放行规则'),
          React.createElement('div', { className: 'ag-set-card-sub' },
            '命中规则直接自动放行（不过 Flash）。示例：tool=edit + mode=danger-full-access → 所有工作区外 edit 自动放行。'),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('input', { className: 'ag-set-input', style: { width: 110 }, placeholder: 'tool', value: newRule.tool, onChange: function (e) { setNewRule(Object.assign({}, newRule, { tool: e.target.value })) } }),
            React.createElement('input', { className: 'ag-set-input', style: { width: 150 }, placeholder: 'mode（可选）', value: newRule.mode, onChange: function (e) { setNewRule(Object.assign({}, newRule, { mode: e.target.value })) } }),
            React.createElement('input', { className: 'ag-set-input', style: { width: 110 }, placeholder: 'category（可选）', value: newRule.category, onChange: function (e) { setNewRule(Object.assign({}, newRule, { category: e.target.value })) } }),
            React.createElement('input', { className: 'ag-set-input', style: { width: 130 }, placeholder: 'contains（可选）', value: newRule.contains, onChange: function (e) { setNewRule(Object.assign({}, newRule, { contains: e.target.value })) } }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn ag-set-btn-primary', disabled: busy || !(newRule.tool || newRule.mode || newRule.category || newRule.contains),
              onClick: function () {
                api({ op: 'add', kind: 'allowRules', value: newRule })
                setNewRule({ tool: '', mode: '', category: '', contains: '' })
              },
            }, '添加'),
          ),
          (cfg.allowRules || []).length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '无白名单规则')
            : React.createElement('div', { className: 'ag-set-list' },
                cfg.allowRules.map(function (rule, idx) {
                  const parts = []
                  if (rule.tool) parts.push('tool=' + rule.tool)
                  if (rule.mode) parts.push('mode=' + rule.mode)
                  if (rule.category) parts.push('category=' + rule.category)
                  if (rule.contains) parts.push('contains=' + rule.contains)
                  const label = parts.join('  ') || '(任意)'
                  const src = ruleSource(rule)
                  const isPre = preAllow.indexOf(JSON.stringify({ mode: rule.mode, description: rule.description })) >= 0 || (rule.mode === 'workspace-write' && !rule.tool && !rule.category && !rule.contains)
                  return React.createElement('div', { className: 'ag-set-item', key: idx },
                    React.createElement('span', { className: 'ag-set-item-label' }, label),
                    rule.description ? React.createElement('span', { className: 'ag-set-item-meta' }, rule.description) : null,
                    RULE_SOURCE_TAGS[src] || RULE_SOURCE_TAGS.default,
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-item-del', title: '删除', 'aria-label': '删除规则',
                      onClick: function () {
                        api({ op: 'remove', kind: 'allowRules', value: { tool: rule.tool, mode: rule.mode, category: rule.category, contains: rule.contains } })
                      },
                    }, '✕'),
                  )
                }),
              ),
        ),

        // ---- 永久人工（denyRules） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '永久人工 · 拒绝升级规则'),
          React.createElement('div', { className: 'ag-set-card-sub' }, '你拒绝过的操作自动升级到这里；命中直接转人工（永不自动放行）。'),
          (cfg.denyRules || []).length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '无永久人工规则')
            : React.createElement('div', { className: 'ag-set-list' },
                cfg.denyRules.map(function (rule, idx) {
                  const parts = []
                  if (rule.tool) parts.push('tool=' + rule.tool)
                  if (rule.mode) parts.push('mode=' + rule.mode)
                  if (rule.category) parts.push('category=' + rule.category)
                  if (rule.contains) parts.push('contains=' + rule.contains)
                  return React.createElement('div', { className: 'ag-set-item', key: idx },
                    React.createElement('span', { className: 'ag-set-item-label' }, parts.join('  ') || '(任意)'),
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-item-del', title: '移除', 'aria-label': '移除规则',
                      onClick: function () {
                        api({ op: 'remove', kind: 'denyRules', value: { tool: rule.tool, mode: rule.mode, category: rule.category, contains: rule.contains } })
                      },
                    }, '✕'),
                  )
                }),
              ),
        ),

        // ---- 学习状态 ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '学习状态'),
          React.createElement('div', { className: 'ag-set-card-sub' },
            '中立操作确认制：同一「工具|模式|类别」确认 ' + (cfg.riskyThreshold - 1) + ' 次后进入阈值状态（指纹命中 / Flash 同类验证自动放行）。'),
          React.createElement('div', { className: 'ag-set-learn' },
            statKeys.length === 0
              ? React.createElement('div', { className: 'ag-set-empty' }, '暂无确认计数')
              : statKeys.map(function (k) {
                  return React.createElement('div', { className: 'ag-set-learn-item', key: k },
                    React.createElement('span', { className: 'ag-set-learn-key' }, '确认 ' + learnStats[k] + '/' + (cfg.riskyThreshold - 1) + ' ·'),
                    React.createElement('span', null, k))
                }),
          ),
          histKeys.length > 0
            ? React.createElement('div', { className: 'ag-set-card-sub' }, '已确认样本（操作指纹）：')
            : null,
          histKeys.length > 0
            ? React.createElement('div', { className: 'ag-set-learn' },
                histKeys.map(function (k) {
                  const samples = learnHistory[k] || []
                  return React.createElement('div', { className: 'ag-set-learn-item', key: k },
                    React.createElement('span', { className: 'ag-set-learn-key' }, k + ' ·'),
                    React.createElement('span', null, samples.map(function (s) { return (s && (s.fp || s.ctx)) || '' }).join(' / ').slice(0, 200)))
                }),
              )
            : null,
        ),

        // ---- 阈值 / 超时 ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-title' }, '阈值与超时'),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('span', { className: 'ag-set-item-meta' }, '确认阈值 N：'),
            React.createElement('input', {
              className: 'ag-set-input ag-set-input-num', type: 'number', min: 2, value: threshold,
              onChange: function (e) { setThreshold(e.target.value) },
            }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn', disabled: busy,
              onClick: function () { api({ op: 'set', kind: 'riskyThreshold', value: Number(threshold) }) },
            }, '保存'),
            React.createElement('span', { className: 'ag-set-item-meta' }, '确认 ' + (Number(threshold) - 1) + ' 次后阈值状态'),
          ),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('span', { className: 'ag-set-item-meta' }, 'Flash 判断超时(ms)：'),
            React.createElement('input', {
              className: 'ag-set-input ag-set-input-num', type: 'number', min: 1000, value: timeoutMs,
              onChange: function (e) { setTimeoutMs(e.target.value) },
            }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn', disabled: busy,
              onClick: function () { api({ op: 'set', kind: 'judgeTimeoutMs', value: Number(timeoutMs) }) },
            }, '保存'),
          ),
        ),

        // ---- 反馈 ----
        feedback
          ? React.createElement('div', { className: feedback.ok ? 'ag-set-ok' : 'ag-set-err' }, feedback.msg)
          : null,
      )
    }

    const plugin = {
      inject: ['timer'],
      async apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        let styleEl = null
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'dsh-approval-gate')
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch (e) {
          console.error('[dsh-approval-gate] 注入样式失败：' + String((e && e.message) || e))
        }
        ctx.effect(() => {
          return () => {
            if (styleEl && styleEl.parentNode) {
              try { styleEl.parentNode.removeChild(styleEl) } catch (e) {}
            }
          }
        })

        // ✅ 自动放行提示条：输入框上方独立行（order=30，排在 todo/goal/queue 之下，天然不重叠）
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'dsh-approval-gate.notice', order: 30, label: '自动放行提示' },
            function (props) { return React.createElement(NoticeStrip, { slotsProps: props }) },
          )
        })

        // 审批历史视图：conversation.view（order=20，位于轨迹 order=10 右侧）
        slots.inject('conversation.view', function () {
          return slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-approval-gate.history',
              order: 20,
              label: '审批',
              inject: (sessionId) => ({ sessionId }),
            },
            function (props) { return React.createElement(HistoryView, { slotsProps: props }) },
          )
        })

        // 设置页：自动审批规则管理（settings.section）
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'dsh-approval-gate.settings', order: 60, label: '自动审批' },
            function (props) { return React.createElement(RulesSettings, { slotsProps: props }) },
          )
        })
      },
    }

    exports.default = plugin
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
