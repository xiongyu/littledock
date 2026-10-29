import type { PluginFrontendApi, MessageRef } from '../../../frontend/src/plugin-api.ts'
import type { PublicSnapshot, PublicItem } from './model.ts'
import type { OptimizerEngine } from './engine.ts'
type Preview = Awaited<ReturnType<OptimizerEngine['preview']>>
type History = Awaited<ReturnType<OptimizerEngine['history']>>
type Tab = 'overview' | 'startup' | 'settings' | 'cleanup' | 'apps' | 'history'
export function activate(api: PluginFrontendApi) {
  const { t: i18nT } = api.i18n

  const { h, ref, shallowRef, computed, watch, onBeforeUnmount, nextTick } = api.vue
  const ruleText = (id: string, field: string, fallback: string) => { const key = `rules.${id}.${field}`, result = i18nT(key); return result === key ? fallback : result }
  const itemName = (item: { id?: string; itemId?: string; name: string }) => ruleText(item.id ?? item.itemId ?? '', 'title', item.name)
  const fonts = Object.fromEntries(['body','heading','caption','metric'].map(flag => [flag, api.getFontInfo(flag)]))
  const icon = (name: string) => h('svg', { viewBox: '0 0 24 24', width: 21, height: 21, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': true }, [h('path', { d: ({ settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2', scan: 'M20 11a8 8 0 1 0-2 7M20 4v7h-7', startup: 'm5 18 2-6L17 2l5 5-10 10-7 1M4 20l-2 2M8 22l2-2', apps: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', history: 'M3 12a9 9 0 1 0 3-7M3 3v6h6M12 7v5l3 2', cleanup: 'M4 7h16M9 3h6l1 4H8l1-4M6 7l1 14h10l1-14M10 10v8m4-8v8' } as Record<string, string>)[name] ?? 'M4 4h16v16H4z' })])
  api.registerTool('main', { component: {
    name: 'SystemOptimizer',
    setup() {
      const tab = ref<Tab>('overview'), snapshot = shallowRef<PublicSnapshot>(), history = shallowRef<History>(), preview = shallowRef<Preview>(), error = ref(''), notice = ref<MessageRef | string>(''), busy = ref<MessageRef | string>('')
      const search = ref(''), source = ref(''), page = ref(0), selected = ref(new Set<string>()), detail = shallowRef<{ name: string; details: string }>()
      let disposed = false, generation = 0
      watch(api.hostState, state => {
        if (state === 'ready') return
        generation++; selected.value = new Set(); snapshot.value = undefined; detail.value = undefined; preview.value = undefined; history.value = undefined
        error.value = ''; busy.value = ''; notice.value = api.i18n.ref('m99eca2717091')
      }, { flush: 'sync' })
      const previewDialog = ref<HTMLDialogElement>()
      watch(preview, async value => { await nextTick(); if (disposed) return; if (value) previewDialog.value?.showModal(); else previewDialog.value?.close() })
      onBeforeUnmount(() => { disposed = true; generation++; selected.value.clear(); snapshot.value = undefined; detail.value = undefined; preview.value = undefined })
      const filtered = computed(() => (snapshot.value?.items ?? []).filter(item => item.category === tab.value && (!source.value || item.source === source.value) && (!search.value || `${itemName(item)} ${item.publisher ?? ''} ${item.source}`.toLowerCase().includes(search.value.toLowerCase())) && (api.config.hideReadOnly !== true || item.category !== 'startup' || item.writable)))
      const visible = computed(() => filtered.value.slice(page.value * 50, (page.value + 1) * 50))
      const sources = computed(() => [...new Set(snapshot.value?.items.filter(item => item.category === tab.value).map(item => item.source) ?? [])])
      watch([tab, search, source], () => { page.value = 0; detail.value = undefined })
      const tabs = (): [Tab, string][] => [['overview',i18nT('mfea405f9b01d')],['startup',i18nT('m842b9f11cdd9')],['settings',i18nT('m68ea5dd4d7af')],['cleanup',i18nT('mc6bdf6d83d2c')],['apps',i18nT('tabs.apps')],['history',i18nT('md6240c5f7436')]]
      const button = (label: string, action: () => unknown, primary = false, disabled = false) => h('button', { class: ['opt-button', primary && 'primary'], disabled: disabled || !!busy.value || api.hostState.value !== 'ready', onClick: action }, label)
      const iconButton = (label: string, name: string, action: () => unknown) => h('button', { class: 'opt-icon-button', title: label, 'aria-label': label, onClick: action, disabled: !!busy.value || api.hostState.value !== 'ready' }, [icon(name)])
      async function currentResult<T>(promise: Promise<T>): Promise<T> {
        const token = generation, result = await promise
        if (disposed || token !== generation || api.hostState.value !== 'ready') throw new Error(i18nT('m6a3b0ce07908'))
        return result
      }
      async function job<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
        const token = generation, { jobId } = await currentResult(api.rpc<{ jobId: string }>(name, params, true)), deadline = Date.now() + 240000
        while (!disposed && token === generation && Date.now() < deadline) {
          const result = await currentResult(api.rpc<{ state: string; result?: T; error?: string; errorRef?: unknown }>('job', { jobId }))
          if (result.state === 'done') return result.result!
          if (result.state === 'failed') throw new Error(api.i18n.message(result.errorRef, result.error))
          await new Promise(resolve => setTimeout(resolve, 400))
        }
        throw new Error(i18nT('m25f8728366d0'))
      }
      async function run(label: MessageRef | string, action: () => Promise<void>) {
        if (busy.value || api.hostState.value !== 'ready') return
        const token = generation
        busy.value = label; error.value = ''; notice.value = ''
        try { await action() } catch (cause) { if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : i18nT('mf06887f1391e') } finally { if (!disposed && token === generation) busy.value = '' }
      }
      async function scan() { await run(api.i18n.ref('mabacb688d0d2'), async () => { const result = await job<PublicSnapshot>('scan'); if (!disposed) { snapshot.value = result; selected.value = new Set(); preview.value = undefined; notice.value = api.i18n.ref('m43b731ce1a1e') } }) }
      async function loadHistory(index = 0) { await run(api.i18n.ref('m3ad506050375'), async () => { const result = await job<History>('history', { page: index }); if (!disposed) history.value = result }) }
      function openTab(value: Tab) { tab.value = value; search.value = ''; source.value = ''; if (value === 'history') void loadHistory() }
      function toggle(item: PublicItem) { const next = new Set(selected.value); if (next.has(item.id)) next.delete(item.id); else if (next.size < 50) next.add(item.id); else { error.value = i18nT('m7f36807aedab'); return } selected.value = next }
      async function prepare() { await run(api.i18n.ref('maea91e8be5ec'), async () => { const result = await job<Preview>('preview', { ids: [...selected.value] }); if (!disposed) preview.value = result }) }
      async function apply() {
        const plan = preview.value; if (!plan) return
        await run(api.i18n.ref('m70c0fecc7247'), async () => {
          preview.value = undefined
          const result = await job<Awaited<ReturnType<OptimizerEngine['apply']>>>('apply', { planId: plan.id, operationId: crypto.randomUUID() })
          if (!disposed) { selected.value = new Set(); snapshot.value = undefined; notice.value = result.status === 'complete' ? api.i18n.ref('m9344dcc2435c') : api.i18n.ref('m31ce064a9846'); tab.value = 'history'; history.value = await job<History>('history') }
        })
      }
      async function restore(id: string) { await run(api.i18n.ref('m9f78664fc5a4'), async () => { const result = await job<Preview>('restorePreview', { id }); if (!disposed) preview.value = result }) }
      async function showDetails(item: PublicItem) { await run(api.i18n.ref('m6f160ba76bd9'), async () => { const result = await currentResult(api.rpc<{ name: string; details: string }>('details', { id: item.id })); if (!disposed) detail.value = result }) }
      function openSystem(value: 'startup' | 'apps' | 'storage') { void run(api.i18n.ref('ma5962a9f229b'), async () => { await currentResult(api.rpc('openSettings', { page: value }, true)); notice.value = api.i18n.ref('me987f726d452') }) }
      const count = (category: PublicItem['category']) => snapshot.value ? snapshot.value.items.filter(item => item.category === category).length : '—'
      const sourceName = (value: string) => value.replace('CurrentUser', i18nT('ma569c636d974')).replace('LocalMachine', i18nT('mc71df3663aa2')).replace('Registry64', i18nT('me5e18ca55c14')).replace('Registry32', i18nT('m57951dead465')).replace('Startup folder', i18nT('m509ed63cc4db')).replace('Automatic service', i18nT('m4189368f78e1')).replace('Startup task', i18nT('m1db3b1afc0fc')).replace('Packaged application', i18nT('m0385b871a017'))
      const stateName = (value: string) => ({ registered: i18nT('m68d2d8fe1c40'), configured: i18nT('m41242bdece2a'), 'not-set': i18nT('m04b77083689b'), custom: i18nT('m5bcd3857473b'), installed: i18nT('ma8b6c39dcabf'), Running: i18nT('m9273b8cc8f40'), Stopped: i18nT('mf006455e3baf'), Ready: i18nT('mab27f80d046f'), Disabled: i18nT('mbc5a87a757a5') } as Record<string, string>)[value] ?? value
      const recordState = (value: string) => ({ complete: i18nT('mf28461bb49c8'), partial: i18nT('m1bd16b45b478'), running: i18nT('m5026a63b58cd'), applied: i18nT('mf58574346081'), conflict: i18nT('m42068738f668'), unknown: i18nT('m33df16b4afab'), pending: i18nT('m231fe2204265'), failed: i18nT('m28384d7afd2e') } as Record<string, string>)[value] ?? value
      const card = (title: string, kind: string, metric: string | number, caption: string, target: Tab) => h('article', { class: ['opt-card', kind] }, [h('header', [icon(kind), h('h2', title)]), h('div', { class: 'opt-card-body' }, [h('strong', { class: 'opt-metric' }, String(metric)), h('p', caption), button(i18nT('mdb8db0530432'), () => openTab(target))])])
      const itemRow = (item: PublicItem) => h('div', { key: item.id, class: ['opt-item', selected.value.has(item.id) && 'selected'] }, [
        item.writable ? h('input', { type: 'checkbox', 'aria-label': i18nT('mf0f5c3b93772', { p0: itemName(item) }), checked: selected.value.has(item.id), disabled: !!busy.value, onChange: () => toggle(item) }) : h('span', { class: 'opt-readonly', title: i18nT('m5c24d28b84f1') }, i18nT('m3b5ec3533b0e')),
        h('div', { class: 'opt-item-main' }, [h('strong', itemName(item)), h('small', item.category === 'apps' ? `${item.publisher || i18nT('m2ec2b433ad5f')} · ${item.version || i18nT('mdc730979055d')}` : ruleText(item.id, 'group', sourceName(item.source)))]),
        h('span', { class: ['opt-state', selected.value.has(item.id) && 'pending'] }, selected.value.has(item.id) ? item.category === 'startup' ? i18nT('me38370b837a2') : i18nT('m6c9030f4128e') : stateName(item.state)),
        iconButton(i18nT('mb6625dad1654', { p0: itemName(item) }), 'apps', () => showDetails(item)),
      ])
      return () => h('div', { class: 'optimizer-tool', style: Object.fromEntries(Object.entries(fonts).map(([flag, font]) => [`--opt-font-${flag}`, `${font.size}px`])) }, [
        h('header', { class: 'opt-heading' }, [h('div', [h('span', { class: 'opt-eyebrow' }, i18nT('md211d89742e7')), h('h1', i18nT('mf6cd91dab1f0')), h('p', snapshot.value ? i18nT('me3d44be8c1f3', { p0: (snapshot.value.computer), p1: (api.i18n.date(snapshot.value.scannedAt, { timeStyle: 'medium' })) }) : i18nT('m51ef7fefc809'))]), h('div', { class: 'opt-heading-actions' }, [iconButton(i18nT('md7dcd37ccef7'), 'settings', () => api.openSettings()), button(i18nT('m13f48f2d7f6e'), scan, true)])]),
        h('nav', { class: 'opt-tabs', 'aria-label': i18nT('ma5e3c83b33eb') }, tabs().map(([value, label]) => h('button', { class: tab.value === value ? 'active' : '', onClick: () => openTab(value), 'aria-current': tab.value === value ? 'page' : undefined }, label))),
        busy.value ? h('p', { class: 'opt-message', role: 'status' }, api.i18n.message(busy.value)) : null,
        error.value ? h('p', { class: 'opt-error', role: 'alert' }, error.value) : null,
        notice.value ? h('p', { class: 'opt-message', role: 'status' }, api.i18n.message(notice.value)) : null,
        tab.value === 'overview' ? h('div', { class: 'opt-overview' }, [card(i18nT('m842b9f11cdd9'), 'startup', count('startup'), i18nT('mbdad78fd42cd'), 'startup'), card(i18nT('mc6bdf6d83d2c'), 'cleanup', 'Windows', i18nT('m6723294995f8'), 'cleanup'), card(i18nT('m68ea5dd4d7af'), 'settings', count('settings'), i18nT('me7c0e3b7d062'), 'settings'), card(i18nT('m3365220f210b'), 'apps', count('apps'), i18nT('mb64dae621711'), 'apps'), card(i18nT('md6240c5f7436'), 'history', i18nT('m8159ac176148'), i18nT('mf516b5ae9e89'), 'history')]) : null,
        ['startup','settings','apps'].includes(tab.value) ? h('section', { class: 'opt-list-section' }, [
          h('header', { class: 'opt-section-heading' }, [h('h2', tabs().find(([value]) => value === tab.value)?.[1] ?? ''), h('span', snapshot.value ? i18nT('m980fda45d8ef', { p0: (filtered.value.length) }) : i18nT('m5f6b5f6c5c51')), tab.value === 'startup' ? button(i18nT('md2c628e397bd'), () => openSystem('startup')) : tab.value === 'apps' ? button(i18nT('m51cf55754729'), () => openSystem('apps')) : null]),
          !snapshot.value ? h('div', { class: 'opt-empty' }, [h('h3', i18nT('mbe38f8154976')), h('p', i18nT('mb4559d38a6b3')), button(i18nT('m743497b67cd2'), scan, true)]) : h('div', [
            h('div', { class: 'opt-filters' }, [h('input', { type: 'search', value: search.value, placeholder: i18nT('m3f0d9f12cd58'), 'aria-label': i18nT('mfde4c11581d6'), onInput: (event: Event) => { search.value = (event.target as HTMLInputElement).value } }), h('select', { value: source.value, 'aria-label': i18nT('mbe09e1c4fe98'), onChange: (event: Event) => { source.value = (event.target as HTMLSelectElement).value } }, [h('option', { value: '' }, i18nT('m9f357adb6100')), ...sources.value.map(value => h('option', { value }, sourceName(value)))])]),
            tab.value === 'startup' ? h('p', { class: 'opt-hint' }, i18nT('mbf33e6adf5c4')) : tab.value === 'settings' ? h('p', { class: 'opt-hint' }, i18nT('mb3069a911f4a')) : null,
            ...visible.value.map(itemRow), !visible.value.length ? h('p', { class: 'opt-empty' }, i18nT('m1b5f97027985')) : null,
            h('footer', { class: 'opt-pagination' }, [button(i18nT('mc9b9ae7a6144'), () => { page.value-- }, false, page.value === 0), h('span', `${page.value + 1} / ${Math.max(1, Math.ceil(filtered.value.length / 50))}`), button(i18nT('m8a8542f69648'), () => { page.value++ }, false, (page.value + 1) * 50 >= filtered.value.length)]),
          ]),
        ]) : null,
        tab.value === 'cleanup' ? h('article', { class: 'opt-card cleanup' }, [h('header', [icon('cleanup'), h('h2', i18nT('mb531e7bbb353'))]), h('div', { class: 'opt-card-body' }, [h('p', i18nT('m177f551455d8')), h('p', { class: 'opt-hint' }, i18nT('mab92b77b4cab')), button(i18nT('mad1f38366858'), () => openSystem('storage'), true)])]) : null,
        tab.value === 'history' ? h('section', { class: 'opt-list-section' }, [h('header', { class: 'opt-section-heading' }, [h('h2', i18nT('md6240c5f7436')), button(i18nT('m621e17c543bc'), () => loadHistory(history.value?.page ?? 0))]), ...(history.value?.items.map(record => h('article', { class: 'opt-history-item' }, [h('div', [h('strong', `${record.restoring ? i18nT('me0534b8a4e46') : i18nT('mf65c42a2540b')} · ${recordState(record.status)}`), h('small', api.i18n.date(record.at, { dateStyle: 'short', timeStyle: 'medium' }))]), h('ul', record.items.map(item => h('li', `${itemName(item)} · ${recordState(item.status)}`))), button(i18nT('m55e4fb4e789b'), () => restore(record.id))])) ?? []), history.value?.items.length === 0 ? h('p', { class: 'opt-empty' }, i18nT('me036e2fe0777')) : null,
          history.value ? h('footer', { class: 'opt-pagination' }, [button(i18nT('m7683ccb55d72'), () => loadHistory(history.value!.page - 1), false, history.value.page === 0), h('span', i18nT('mb3c1e04d9235', { p0: (history.value.total) })), button(i18nT('m8ed1851d8859'), () => loadHistory(history.value!.page + 1), false, (history.value.page + 1) * 20 >= history.value.total)]) : null,
        ]) : null,
        detail.value ? h('aside', { class: 'opt-detail', 'aria-label': i18nT('m5e38b58eba75') }, [h('h2', detail.value.name), h('pre', detail.value.details), button(i18nT('m0ae7312510f4'), () => { detail.value = undefined })]) : null,
        selected.value.size ? h('footer', { class: 'opt-action-bar' }, [h('span', i18nT('mf320b5f58bee', { p0: (selected.value.size) })), button(i18nT('m5288519d856d'), () => { selected.value = new Set() }), button(i18nT('m9661c8114770'), prepare, true)]) : null,
        h('dialog', { ref: previewDialog, class: 'opt-preview', 'aria-label': i18nT('m742de65d2b71'), onCancel: (event: Event) => { event.preventDefault(); if (!busy.value) preview.value = undefined } }, preview.value ? [h('header', [h('h2', preview.value.restoring ? i18nT('m10328a6f1af8') : i18nT('m1e462838759e')), h('span', i18nT('m6866e7a8ab19'))]), ...preview.value.items.map(item => h('div', { class: 'opt-preview-row' }, [h('strong', itemName(item)), h('span', `${api.i18n.message(item.before)} → ${api.i18n.message(item.after)}`), h('small', api.i18n.message(item.note))])), h('footer', [button(i18nT('m2cd0f3be8738'), () => { preview.value = undefined }), button(i18nT('m007cf1fd145d', { p0: (preview.value.restoring ? i18nT('me0534b8a4e46') : i18nT('m63c73c4730f4')), p1: (preview.value.items.length) }), apply, true)])] : []),
        snapshot.value ? h('details', { class: 'opt-coverage' }, [h('summary', i18nT('mb272a7e91f19')), h('p', i18nT('m1ce091daa6e7')), h('p', i18nT('m06491580c50f')), ...snapshot.value.warnings.filter(warning => !warning.startsWith('StartupApproved')).map(warning => h('p', warning.replace('Unable to read', i18nT('mc27041585556')).replace('Service enumeration unavailable', i18nT('me9bcfcb1c1a3')).replace('Scheduled task enumeration unavailable', i18nT('m54a74d5542d5')).replace('Application enumeration incomplete', i18nT('mdb45ad3aa920')).replace('Packaged applications unavailable', i18nT('m563152745996')).replace('Startup folder unavailable', i18nT('m832178c3c1a2')).replace('Setting unavailable:', i18nT('m16a81f88d849')).replace('Enumeration is bounded: 1000 entries per startup source and packaged apps, 2000 entries per desktop-app registry source, 10000 entries total. Larger sources may be incomplete.', i18nT('m945da02010fd')).replace('Total enumeration truncated at 10000 entries.', i18nT('m2244203ece67'))))]) : null,
      ])
    },
  } })
}
