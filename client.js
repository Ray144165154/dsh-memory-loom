/**
 * dsh-memory-loom — browser half.
 *
 * Ship shape for a DSH client plugin: a CommonJS module handed to the shell's
 * module loader, whose factory returns `{ inject, apply }`. The `id` MUST equal
 * the package name, because the shell serves this file from
 * `/plugins/<name>/client.js` and matches the registration against it.
 *
 * The settings card is registered into the `settings.plugin.item` slot, which
 * renders one `<li>` per plugin inside Settings → Plugins. The component
 * therefore returns an `li`, not a `div`.
 *
 * Only `react` is required: the shared module table is deliberately small, so
 * anything else would have to be inlined. Keeping the card dependency-free
 * avoids pulling a UI component library into the bundle for four buttons.
 *
 * @module dsh-memory-loom/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-loom',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'settings.memoryLoom'

    const zh = {
      title: '长期记忆',
      description: '跨会话的持久记忆与联想召回',
      configHint: '本卡片是状态与操作面板。配置项（召回条数、分数门限、自动抽取等）在 profile 的 cordis.patch.yml 里本插件那一行的 config: 之下。',
      loading: '正在读取记忆…',
      empty: '还没有存储任何记忆。可以从历史会话回填，或直接开始对话。',
      live: '生效',
      total: '总计',
      links: '联想',
      superseded: '已取代',
      recent: '最近记忆',
      backfill: '从历史会话回填',
      backfilling: '正在回填…',
      evict: '清理超限',
      forget: '遗忘',
      reload: '重新读取',
      kinds: '类型分布',
      source: '来源',
      uses: '被召回',
      none: '无',
      done: '完成',
      backfillDone: added => `回填完成：新增 ${added.added} 条，强化 ${added.strengthened} 条，扫描 ${added.sessions} 个会话`,
      evictDone: result => `已清理 ${result.evicted} 条，剩余 ${result.live} 条`,
      forgetDone: '已遗忘',
      loadFailed: '读取失败，请点击重新读取。',
      actionFailed: '操作失败',
    }

    const en = {
      title: 'Long-term memory',
      description: 'Durable cross-session memory with association-based recall',
      configHint: 'This card is a status and action panel. Settings (recall budget, score floor, auto-extraction) live in the profile\'s cordis.patch.yml under this plugin\'s config: block.',
      loading: 'Loading memories…',
      empty: 'Nothing stored yet. Backfill from past sessions, or just start talking.',
      live: 'live',
      total: 'total',
      links: 'associations',
      superseded: 'superseded',
      recent: 'Recent memories',
      backfill: 'Backfill from past sessions',
      backfilling: 'Backfilling…',
      evict: 'Enforce limit',
      forget: 'Forget',
      reload: 'Reload',
      kinds: 'Kinds',
      source: 'source',
      uses: 'recalled',
      none: 'none',
      done: 'Done',
      backfillDone: added => `Backfill done: ${added.added} added, ${added.strengthened} strengthened across ${added.sessions} sessions`,
      evictDone: result => `Evicted ${result.evicted}, ${result.live} remain`,
      forgetDone: 'Forgotten',
      loadFailed: 'Could not load. Try reloading.',
      actionFailed: 'Action failed',
    }

    /** One small JSON round trip against this plugin's own routes. */
    async function callApi(endpoint, payload, signal) {
      const isRead = endpoint === 'stats'
      const response = await fetch(`/api/memory-loom.${endpoint}`, {
        method: isRead ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        ...(isRead ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) }),
      })
      const text = await response.text()
      let data
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        throw new Error('invalid response')
      }
      if (!response.ok) throw new Error(data.error ?? 'request failed')
      return data
    }

    const css = `
      .dshMemoryCard{list-style:none;border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-3,transparent);border-radius:16px;transition:border-color .16s,background .16s}
      .dshMemoryCard:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5))}
      .dshMemoryHead{display:flex;align-items:center;gap:10px;width:100%;padding:14px 16px;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .dshMemoryTitle{font-weight:600}
      .dshMemorySummary{margin-left:auto;color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.85));font-size:.86em;white-space:nowrap}
      .dshMemoryBody{padding:0 16px 16px;display:flex;flex-direction:column;gap:12px}
      .dshMemoryStats{display:flex;flex-wrap:wrap;gap:6px}
      .dshMemoryPill{font-size:.78em;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}
      .dshMemoryActions{display:flex;gap:8px;flex-wrap:wrap}
      .dshMemoryActions button{padding:6px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;cursor:pointer}
      .dshMemoryActions button:disabled{opacity:.5;cursor:default}
      .dshMemoryList{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;max-height:320px;overflow:auto}
      .dshMemoryItem{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1))}
      .dshMemoryKind{font-size:.74em;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2));white-space:nowrap}
      .dshMemoryText{flex:1;font-size:.88em;line-height:1.45;word-break:break-word}
      .dshMemoryMeta{font-size:.74em;color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.85));margin-top:3px}
      .dshMemoryForget{border:0;background:none;color:inherit;opacity:.6;cursor:pointer;font:inherit;font-size:.78em}
      .dshMemoryForget:hover{opacity:1}
      .dshMemoryHint{font-size:.85em;color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.85));margin:0}
      .dshMemoryError{font-size:.85em;color:var(--dsw-alias-label-error,#e5534b);margin:0}
    `

    /**
     * The settings card.
     *
     * `t` is injected by the slot from the locale namespace declared at
     * registration; `callApi` comes from this slot's own `inject` factory.
     */
    function MemoryCard({ t, callApi: api }) {
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const lifetime = React.useRef(new AbortController())

      const load = React.useCallback(async signal => {
        try {
          const result = await api('stats', {}, signal)
          if (!signal?.aborted) {
            setData(result)
            setError('')
          }
        } catch (failure) {
          if (!signal?.aborted) setError(failure?.message ?? String(failure))
        }
      }, [api])

      React.useEffect(() => {
        // The controller is owned by the card's lifetime, not by this effect:
        // collapsing and re-expanding the card must not cancel a load that is
        // still in flight for the same mount.
        const controller = lifetime.current
        void load(controller.signal)
        return () => controller.abort()
      }, [load])

      const act = async (endpoint, payload, describe) => {
        setBusy(true)
        setStatus('')
        setError('')
        try {
          const result = await api(endpoint, payload)
          setStatus(describe(result))
          await load()
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setBusy(false)
        }
      }

      const stats = data?.stats
      const summary = data === null
        ? t('loading')
        : `${stats.live} ${t('live')} · ${stats.links} ${t('links')}`

      return h('li', { className: 'dshMemoryCard', 'data-testid': 'memory-loom-card' },
        h('button', {
          type: 'button',
          className: 'dshMemoryHead',
          'aria-expanded': open,
          onClick: () => setOpen(value => !value),
        },
          h('span', { className: 'dshMemoryTitle' }, t('title')),
          h('span', { className: 'dshMemorySummary' }, summary)),
        !open ? null : h('div', { className: 'dshMemoryBody' },
          h('p', { className: 'dshMemoryHint' }, t('description')),
          h('p', { className: 'dshMemoryHint' }, t('configHint')),
          error !== '' && h('p', { className: 'dshMemoryError', role: 'alert' }, `${t('actionFailed')}: ${error}`),
          status !== '' && h('p', { className: 'dshMemoryHint', role: 'status' }, status),
          data === null ? h('p', { className: 'dshMemoryHint' }, t('loading')) : h(React.Fragment, null,
            h('div', { className: 'dshMemoryStats' },
              h('span', { className: 'dshMemoryPill' }, `${t('live')} ${stats.live}`),
              h('span', { className: 'dshMemoryPill' }, `${t('total')} ${stats.total}`),
              h('span', { className: 'dshMemoryPill' }, `${t('links')} ${stats.links}`),
              h('span', { className: 'dshMemoryPill' }, `${t('superseded')} ${stats.superseded}`),
              Object.entries(stats.byKind ?? {}).map(([kind, count]) =>
                h('span', { className: 'dshMemoryPill', key: kind }, `${kind} ${count}`))),
            h('div', { className: 'dshMemoryActions' },
              h('button', {
                type: 'button',
                disabled: busy,
                onClick: () => act('backfill', {}, t('backfillDone')),
              }, t(busy ? 'backfilling' : 'backfill')),
              h('button', {
                type: 'button',
                disabled: busy,
                onClick: () => act('evict', {}, t('evictDone')),
              }, t('evict')),
              h('button', {
                type: 'button',
                disabled: busy,
                onClick: () => load(lifetime.current.signal),
              }, t('reload'))),
            (data.recent ?? []).length === 0
              ? h('p', { className: 'dshMemoryHint' }, t('empty'))
              : h('ul', { className: 'dshMemoryList' },
                data.recent.map(item => h('li', { className: 'dshMemoryItem', key: item.id },
                  h('span', { className: 'dshMemoryKind' }, item.kind),
                  h('span', { className: 'dshMemoryText' },
                    item.text,
                    h('span', { className: 'dshMemoryMeta' },
                      `${t('source')} ${item.source} · ${t('uses')} ${item.useCount} · ${t('links')} ${item.links} · ${new Date(item.updatedAt).toISOString().slice(0, 10)}`)),
                  h('button', {
                    type: 'button',
                    className: 'dshMemoryForget',
                    disabled: busy,
                    title: t('forget'),
                    onClick: () => act('forget', { id: item.id }, () => t('forgetDone')),
                  }, t('forget')))))),
        ))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory-loom locale')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-memory-loom'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'memory-loom styles')
        // `key` MUST equal the host half's SETTINGS_NAMESPACE. The Plugins tab
        // enumerates registered settings namespaces and dispatches this slot
        // once per namespace, so a key that matches no namespace renders
        // nothing and reports nothing — the card simply never appears.
        // `tools/smoke.mjs` asserts this equality so the two cannot drift.
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'memory-loom',
          order: 40,
          locale: NS,
          inject: () => ({ callApi }),
        }, MemoryCard))
      },
    }
  },
})
