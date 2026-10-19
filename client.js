// dshx-skill-manager — browser half.
//
// Contributes a "技能管理" Settings page: every installed skill with a short
// summary and an on/off switch, backed by the host half's /dshx-skill-manager/*
// endpoints.
window.__ModuleLoader__.load({
  id: 'dshx-skill-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const SOURCE_LABEL = {
      'project-dsh': '项目 .dsh',
      'project-agents': '项目 .agents',
      'user-dsh': '用户 ~/.dsh',
      'user-agents': '用户 ~/.agents',
      runtime: '运行时',
      custom: '自定义目录',
      bundled: '内置',
    }

    const card = {
      border: '1px solid rgba(127,127,127,0.22)',
      borderRadius: 10,
      padding: '12px 14px',
      background: 'rgba(127,127,127,0.07)',
      display: 'flex',
      gap: 14,
      alignItems: 'flex-start',
    }
    const button = {
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: 6,
      padding: '5px 12px',
      fontSize: 12,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const input = {
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: 6,
      padding: '5px 10px',
      fontSize: 12,
      minWidth: 0,
    }
    const tag = {
      display: 'inline-block',
      padding: '0 7px',
      borderRadius: 99,
      fontSize: 10.5,
      lineHeight: '17px',
      border: '1px solid rgba(127,127,127,0.3)',
      opacity: 0.75,
      whiteSpace: 'nowrap',
    }
    const errorText = { fontSize: 12, color: '#d9534f', lineHeight: 1.6 }

    function api(path, body) {
      const init = body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      return fetch('/dshx-skill-manager/' + path, init).then((response) =>
        response.json().catch(() => ({})).then((data) => {
          if (!response.ok) throw new Error(data.error || 'HTTP ' + String(response.status))
          return data
        }))
    }

    function Switch(props) {
      const on = props.checked
      return h('button', {
        role: 'switch',
        'aria-checked': on,
        title: on ? '已启用，点击停用' : '已停用，点击启用',
        disabled: props.disabled,
        onClick: props.onChange,
        style: {
          flex: 'none',
          width: 38,
          height: 22,
          borderRadius: 11,
          border: 'none',
          padding: 2,
          cursor: props.disabled ? 'default' : 'pointer',
          background: on ? '#2ea043' : 'rgba(127,127,127,0.4)',
          opacity: props.disabled ? 0.5 : 1,
          transition: 'background 0.15s',
          marginTop: 2,
        },
      }, h('span', {
        style: {
          display: 'block',
          width: 18,
          height: 18,
          borderRadius: 9,
          background: '#fff',
          transform: on ? 'translateX(16px)' : 'translateX(0)',
          transition: 'transform 0.15s',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        },
      }))
    }

    function SkillCard(props) {
      const skill = props.skill
      const [open, setOpen] = React.useState(false)
      const tags = [h('span', { key: 's', style: tag }, SOURCE_LABEL[skill.source] || skill.source)]
      if (!skill.modelInvocable) tags.push(h('span', { key: 'm', style: tag }, '仅用户调用'))
      if (!skill.userInvocable) tags.push(h('span', { key: 'u', style: tag }, '仅模型调用'))
      if (skill.summaryKind === 'ai') tags.push(h('span', { key: 'a', style: tag, title: 'AI 生成的概述' }, 'AI 概述'))
      return h('div', { style: Object.assign({}, card, skill.enabled ? {} : { opacity: 0.55 }) },
        h(Switch, { checked: skill.enabled, disabled: props.busy, onChange: () => props.onToggle(skill) }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('code', { style: { fontSize: 13, fontWeight: 600 } }, skill.name),
            tags),
          h('div', { style: { marginTop: 5, fontSize: 12.5, lineHeight: 1.6 } }, skill.summary),
          h('div', {
            style: { marginTop: 4, fontSize: 11, opacity: 0.55, cursor: 'pointer', userSelect: 'none' },
            onClick: () => setOpen(!open),
          }, open ? '▾ 收起原始描述' : '▸ 查看原始描述'),
          open ? h('div', { style: { marginTop: 6, fontSize: 11.5, opacity: 0.75, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            skill.description,
            skill.whenToUse ? '\n\n适用场景：' + skill.whenToUse : '',
            skill.path ? '\n\n位置：' + skill.path : '') : null))
    }

    function SkillSection() {
      const [cwd, setCwd] = React.useState('')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [summarizing, setSummarizing] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        setBusy(true)
        api('skills' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''))
          .then((result) => {
            if (!alive) return
            setData(result)
            setError('')
            if (!cwd && result.cwd) setCwd(result.cwd)
          })
          .catch((e) => { if (alive) setError(e.message || String(e)) })
          .finally(() => { if (alive) setBusy(false) })
        return () => { alive = false }
      }, [cwd, nonce])

      // While the host fills summaries in the background, poll until it finishes.
      React.useEffect(() => {
        if (!data || !data.summarizing) return undefined
        const timer = setTimeout(() => setNonce((n) => n + 1), 5000)
        return () => clearTimeout(timer)
      }, [data])

      function toggle(skill) {
        const next = !skill.enabled
        setData((prev) => prev && Object.assign({}, prev, {
          skills: prev.skills.map((s) => s.name === skill.name ? Object.assign({}, s, { enabled: next }) : s),
        }))
        api('toggle', { name: skill.name, enabled: next })
          .then(() => setNotice((next ? '已启用 ' : '已停用 ') + skill.name + '（下一轮对话生效）'))
          .catch((e) => {
            setError('切换失败：' + (e.message || String(e)))
            setNonce((n) => n + 1)
          })
      }

      function setAll(enabled, list) {
        Promise.all(list.filter((s) => s.enabled !== enabled).map((s) => api('toggle', { name: s.name, enabled })))
          .then(() => setNotice(enabled ? '已全部启用' : '已全部停用'))
          .catch((e) => setError('批量切换失败：' + (e.message || String(e))))
          .finally(() => setNonce((n) => n + 1))
      }

      function summarize(force) {
        setSummarizing(true)
        setNotice('正在用默认模型生成概述…')
        api('summarize', { cwd: cwd || undefined, force })
          .then((r) => {
            const tail = r.errors && r.errors.length ? '；部分失败：' + r.errors[0] : ''
            setNotice('已生成 ' + String(r.done) + '/' + String(r.requested) + ' 条概述（' + r.model + '）' + tail)
            setNonce((n) => n + 1)
          })
          .catch((e) => setNotice('生成概述失败：' + (e.message || String(e))))
          .finally(() => setSummarizing(false))
      }

      const skills = data ? data.skills : []
      const query = filter.trim().toLowerCase()
      const shown = query
        ? skills.filter((s) => (s.name + ' ' + s.summary + ' ' + s.description).toLowerCase().includes(query))
        : skills
      const enabledCount = skills.filter((s) => s.enabled).length
      const needSummary = skills.some((s) => s.summaryKind !== 'ai')
      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []

      return h('div', { style: { padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12, color: 'inherit' } },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } },
          h('div', null,
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, '技能管理'),
            h('div', { style: { marginTop: 4, fontSize: 12, opacity: 0.6 } },
              data ? '共 ' + String(skills.length) + ' 个技能，已启用 ' + String(enabledCount) + ' 个'
                + (data.summarizing ? ' · 正在后台生成中文概述…' : '') : '读取中…')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            data && data.summarizeEnabled
              ? h('button', {
                  style: summarizing ? Object.assign({}, button, { opacity: 0.45 }) : button,
                  disabled: summarizing,
                  title: needSummary ? '为尚无 AI 概述的技能生成中文概述' : '重新生成全部概述',
                  onClick: () => summarize(!needSummary),
                }, summarizing ? '生成中…' : needSummary ? 'AI 生成概述' : '重新生成概述')
              : null,
            h('button', { style: button, disabled: busy, onClick: () => setNonce((n) => n + 1) }, busy ? '刷新中' : '刷新'))),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('select', {
            style: Object.assign({}, input, { maxWidth: 360 }),
            value: cwd,
            title: '项目级技能（.dsh/skills、.agents/skills）随工作区变化',
            onChange: (e) => setCwd(e.target.value),
          }, (workspaces.indexOf(cwd) < 0 && cwd ? [cwd].concat(workspaces) : workspaces).map((w) => h('option', { key: w, value: w }, '工作区：' + w))),
          h('input', {
            style: Object.assign({}, input, { flex: 1, minWidth: 140 }),
            placeholder: '搜索技能…',
            value: filter,
            onChange: (e) => setFilter(e.target.value),
          }),
          h('button', { style: button, onClick: () => setAll(true, shown) }, '全部启用'),
          h('button', { style: button, onClick: () => setAll(false, shown) }, '全部停用')),
        notice ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, notice) : null,
        error ? h('div', { style: errorText }, error) : null,
        data && data.complete === false ? h('div', { style: { fontSize: 12, color: '#d29922' } }, '部分技能来源未能完整读取，列表可能不全。') : null,
        shown.map((skill) => h(SkillCard, { key: skill.name, skill, busy, onToggle: toggle })),
        data && shown.length === 0 ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, query ? '没有匹配的技能' : '当前工作区没有安装任何技能') : null,
        h('div', { style: { fontSize: 11, opacity: 0.45, lineHeight: 1.6 } },
          '停用的技能会从模型的技能目录、skill 工具和 /技能 调用中隐藏，不会修改或删除技能文件；开关全局生效，从下一轮对话开始。 · dshx-skill-manager v1.0.0'))
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dshx-skill-manager',
        order: 31,
        label: '技能管理',
      }, SkillSection))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
