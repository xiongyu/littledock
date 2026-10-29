export function activate(api) {
    const { h, ref, shallowRef, computed, watch, onBeforeUnmount, nextTick } = api.vue;
    const fonts = Object.fromEntries(['body', 'heading', 'caption', 'metric'].map(flag => [flag, api.getFontInfo(flag)]));
    const icon = (name) => h('svg', { viewBox: '0 0 24 24', width: 21, height: 21, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': true }, [h('path', { d: { settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2', scan: 'M20 11a8 8 0 1 0-2 7M20 4v7h-7', startup: 'm5 18 2-6L17 2l5 5-10 10-7 1M4 20l-2 2M8 22l2-2', apps: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', history: 'M3 12a9 9 0 1 0 3-7M3 3v6h6M12 7v5l3 2', cleanup: 'M4 7h16M9 3h6l1 4H8l1-4M6 7l1 14h10l1-14M10 10v8m4-8v8' }[name] ?? 'M4 4h16v16H4z' })]);
    api.registerTool('main', { component: {
            name: 'SystemOptimizer',
            setup() {
                const tab = ref('overview'), snapshot = shallowRef(), history = shallowRef(), preview = shallowRef(), error = ref(''), notice = ref(''), busy = ref('');
                const search = ref(''), source = ref(''), page = ref(0), selected = ref(new Set()), detail = shallowRef();
                let disposed = false, generation = 0;
                watch(api.hostState, state => {
                    if (state === 'ready')
                        return;
                    generation++;
                    selected.value = new Set();
                    snapshot.value = undefined;
                    detail.value = undefined;
                    preview.value = undefined;
                    history.value = undefined;
                    error.value = '';
                    busy.value = '';
                    notice.value = '连接恢复并解锁后，请重新扫描或查看恢复记录。';
                }, { flush: 'sync' });
                const previewDialog = ref();
                watch(preview, async (value) => { await nextTick(); if (disposed)
                    return; if (value)
                    previewDialog.value?.showModal();
                else
                    previewDialog.value?.close(); });
                onBeforeUnmount(() => { disposed = true; generation++; selected.value.clear(); snapshot.value = undefined; detail.value = undefined; preview.value = undefined; });
                const filtered = computed(() => (snapshot.value?.items ?? []).filter(item => item.category === tab.value && (!source.value || item.source === source.value) && (!search.value || `${item.name} ${item.publisher ?? ''} ${item.source}`.toLowerCase().includes(search.value.toLowerCase())) && (api.config.hideReadOnly !== true || item.category !== 'startup' || item.writable)));
                const visible = computed(() => filtered.value.slice(page.value * 50, (page.value + 1) * 50));
                const sources = computed(() => [...new Set(snapshot.value?.items.filter(item => item.category === tab.value).map(item => item.source) ?? [])]);
                watch([tab, search, source], () => { page.value = 0; detail.value = undefined; });
                const tabs = [['overview', '概览'], ['startup', '开机启动'], ['settings', '系统设置'], ['cleanup', '空间管理'], ['apps', '应用'], ['history', '恢复记录']];
                const button = (label, action, primary = false, disabled = false) => h('button', { class: ['opt-button', primary && 'primary'], disabled: disabled || !!busy.value || api.hostState.value !== 'ready', onClick: action }, label);
                const iconButton = (label, name, action) => h('button', { class: 'opt-icon-button', title: label, 'aria-label': label, onClick: action, disabled: !!busy.value || api.hostState.value !== 'ready' }, [icon(name)]);
                async function currentResult(promise) {
                    const token = generation, result = await promise;
                    if (disposed || token !== generation || api.hostState.value !== 'ready')
                        throw new Error('页面状态已变化，请重新核对。');
                    return result;
                }
                async function job(name, params = {}) {
                    const token = generation, { jobId } = await currentResult(api.rpc(name, params, true)), deadline = Date.now() + 240000;
                    while (!disposed && token === generation && Date.now() < deadline) {
                        const result = await currentResult(api.rpc('job', { jobId }));
                        if (result.state === 'done')
                            return result.result;
                        if (result.state === 'failed')
                            throw new Error(result.error);
                        await new Promise(resolve => setTimeout(resolve, 400));
                    }
                    throw new Error('等待结束，请通过恢复记录核对。不会重复提交。');
                }
                async function run(label, action) {
                    if (busy.value || api.hostState.value !== 'ready')
                        return;
                    const token = generation;
                    busy.value = label;
                    error.value = '';
                    notice.value = '';
                    try {
                        await action();
                    }
                    catch (cause) {
                        if (!disposed && token === generation)
                            error.value = cause instanceof Error ? cause.message : '操作失败，请重新核对。';
                    }
                    finally {
                        if (!disposed && token === generation)
                            busy.value = '';
                    }
                }
                async function scan() { await run('正在扫描本机…', async () => { const result = await job('scan'); if (!disposed) {
                    snapshot.value = result;
                    selected.value = new Set();
                    preview.value = undefined;
                    notice.value = '扫描完成。未更改任何系统设置。';
                } }); }
                async function loadHistory(index = 0) { await run('正在读取恢复记录…', async () => { const result = await job('history', { page: index }); if (!disposed)
                    history.value = result; }); }
                function openTab(value) { tab.value = value; search.value = ''; source.value = ''; if (value === 'history')
                    void loadHistory(); }
                function toggle(item) { const next = new Set(selected.value); if (next.has(item.id))
                    next.delete(item.id);
                else if (next.size < 50)
                    next.add(item.id);
                else {
                    error.value = '每次最多选择 50 项。';
                    return;
                } selected.value = next; }
                async function prepare() { await run('正在核对原值…', async () => { const result = await job('preview', { ids: [...selected.value] }); if (!disposed)
                    preview.value = result; }); }
                async function apply() {
                    const plan = preview.value;
                    if (!plan)
                        return;
                    await run('正在备份并应用更改…', async () => {
                        preview.value = undefined;
                        const result = await job('apply', { planId: plan.id, operationId: crypto.randomUUID() });
                        if (!disposed) {
                            selected.value = new Set();
                            snapshot.value = undefined;
                            notice.value = result.status === 'complete' ? '更改已读回核对。请重新登录后检查界面效果，可在恢复记录中还原。' : '部分项目未完成。请先查看恢复记录，不要重复执行。';
                            tab.value = 'history';
                            history.value = await job('history');
                        }
                    });
                }
                async function restore(id) { await run('正在核对恢复条件…', async () => { const result = await job('restorePreview', { id }); if (!disposed)
                    preview.value = result; }); }
                async function showDetails(item) { await run('正在读取详情…', async () => { const result = await currentResult(api.rpc('details', { id: item.id })); if (!disposed)
                    detail.value = result; }); }
                function openSystem(value) { void run('正在打开 Windows 设置…', async () => { await currentResult(api.rpc('openSettings', { page: value }, true)); notice.value = '已请求 Windows 打开对应设置。'; }); }
                const count = (category) => snapshot.value ? snapshot.value.items.filter(item => item.category === category).length : '—';
                const sourceName = (value) => value.replace('CurrentUser', '当前用户').replace('LocalMachine', '本机范围').replace('Registry64', '64 位').replace('Registry32', '32 位').replace('Startup folder', '启动文件夹').replace('Automatic service', '自动服务').replace('Startup task', '开机 / 登录任务').replace('Packaged application', '商店应用');
                const stateName = (value) => ({ registered: '已登记 · 启用状态未知', configured: '已设为目标值', 'not-set': '系统默认', custom: '当前自定义值', installed: '已安装', Running: '正在运行', Stopped: '已停止', Ready: '已就绪', Disabled: '已禁用' }[value] ?? value);
                const recordState = (value) => ({ complete: '已完成', partial: '部分完成', running: '执行中', applied: '已应用', conflict: '发生冲突', unknown: '待核对', pending: '未执行', failed: '失败' }[value] ?? value);
                const card = (title, kind, metric, caption, target) => h('article', { class: ['opt-card', kind] }, [h('header', [icon(kind), h('h2', title)]), h('div', { class: 'opt-card-body' }, [h('strong', { class: 'opt-metric' }, String(metric)), h('p', caption), button('查看', () => openTab(target))])]);
                const itemRow = (item) => h('div', { key: item.id, class: ['opt-item', selected.value.has(item.id) && 'selected'] }, [
                    item.writable ? h('input', { type: 'checkbox', 'aria-label': `选择 ${item.name}`, checked: selected.value.has(item.id), disabled: !!busy.value, onChange: () => toggle(item) }) : h('span', { class: 'opt-readonly', title: '当前版本只读' }, '只读'),
                    h('div', { class: 'opt-item-main' }, [h('strong', item.name), h('small', item.category === 'apps' ? `${item.publisher || '发布者未知'} · ${item.version || '版本未知'}` : sourceName(item.source))]),
                    h('span', { class: ['opt-state', selected.value.has(item.id) && 'pending'] }, selected.value.has(item.id) ? item.category === 'startup' ? '将停用登记' : '将应用设置' : stateName(item.state)),
                    iconButton(`${item.name}详情`, 'apps', () => showDetails(item)),
                ]);
                return () => h('div', { class: 'optimizer-tool', style: Object.fromEntries(Object.entries(fonts).map(([flag, font]) => [`--opt-font-${flag}`, `${font.size}px`])) }, [
                    h('header', { class: 'opt-heading' }, [h('div', [h('span', { class: 'opt-eyebrow' }, '本机 · WINDOWS'), h('h1', '系统优化'), h('p', snapshot.value ? `${snapshot.value.computer} · ${new Date(snapshot.value.scannedAt).toLocaleTimeString()} 扫描` : '先查看，再选择更改。')]), h('div', { class: 'opt-heading-actions' }, [iconButton('系统优化插件设置', 'settings', () => api.openSettings()), button('扫描本机', scan, true)])]),
                    h('nav', { class: 'opt-tabs', 'aria-label': '系统优化页面' }, tabs.map(([value, label]) => h('button', { class: tab.value === value ? 'active' : '', onClick: () => openTab(value), 'aria-current': tab.value === value ? 'page' : undefined }, label))),
                    busy.value ? h('p', { class: 'opt-message', role: 'status' }, busy.value) : null,
                    error.value ? h('p', { class: 'opt-error', role: 'alert' }, error.value) : null,
                    notice.value ? h('p', { class: 'opt-message', role: 'status' }, notice.value) : null,
                    tab.value === 'overview' ? h('div', { class: 'opt-overview' }, [card('开机启动', 'startup', count('startup'), '查看登记来源，选择可恢复的停用项', 'startup'), card('空间管理', 'cleanup', 'Windows', '打开系统存储设置，管理临时文件', 'cleanup'), card('系统设置', 'settings', count('settings'), '用户级设置 · 修改前保存原值', 'settings'), card('已装应用', 'apps', count('apps'), '应用清单与 Windows 卸载入口', 'apps'), card('恢复记录', 'history', '可追溯', '加密保存原值，恢复前再次核对', 'history')]) : null,
                    ['startup', 'settings', 'apps'].includes(tab.value) ? h('section', { class: 'opt-list-section' }, [
                        h('header', { class: 'opt-section-heading' }, [h('h2', tabs.find(([value]) => value === tab.value)?.[1] ?? ''), h('span', snapshot.value ? `${filtered.value.length} 项` : '尚未扫描'), tab.value === 'startup' ? button('系统启动设置', () => openSystem('startup')) : tab.value === 'apps' ? button('系统卸载入口', () => openSystem('apps')) : null]),
                        !snapshot.value ? h('div', { class: 'opt-empty' }, [h('h3', '先扫描本机'), h('p', '读取当前设置和登记信息。'), button('开始扫描', scan, true)]) : h('div', [
                            h('div', { class: 'opt-filters' }, [h('input', { type: 'search', value: search.value, placeholder: '搜索名称或来源', 'aria-label': '搜索优化项目', onInput: (event) => { search.value = event.target.value; } }), h('select', { value: source.value, 'aria-label': '按来源筛选', onChange: (event) => { source.value = event.target.value; } }, [h('option', { value: '' }, '全部来源'), ...sources.value.map(value => h('option', { value }, sourceName(value)))])]),
                            tab.value === 'startup' ? h('p', { class: 'opt-hint' }, '只修改当前用户的普通 Run 登记。启动文件夹、服务和任务只读；登记不等于实际启用，启动影响未测量。') : tab.value === 'settings' ? h('p', { class: 'opt-hint' }, '按需选择，不预选。修改后通常需重新登录核对，不自动重启。') : null,
                            ...visible.value.map(itemRow), !visible.value.length ? h('p', { class: 'opt-empty' }, '没有匹配的项目。') : null,
                            h('footer', { class: 'opt-pagination' }, [button('上一页', () => { page.value--; }, false, page.value === 0), h('span', `${page.value + 1} / ${Math.max(1, Math.ceil(filtered.value.length / 50))}`), button('下一页', () => { page.value++; }, false, (page.value + 1) * 50 >= filtered.value.length)]),
                        ]),
                    ]) : null,
                    tab.value === 'cleanup' ? h('article', { class: 'opt-card cleanup' }, [h('header', [icon('cleanup'), h('h2', 'Windows 空间管理')]), h('div', { class: 'opt-card-body' }, [h('p', '打开系统存储页面查看临时文件、应用占用和清理建议。'), h('p', { class: 'opt-hint' }, '本版本由 Windows 提供清理确认；插件不会直接删除文件或清空回收站。'), button('打开存储设置', () => openSystem('storage'), true)])]) : null,
                    tab.value === 'history' ? h('section', { class: 'opt-list-section' }, [h('header', { class: 'opt-section-heading' }, [h('h2', '恢复记录'), button('刷新记录', () => loadHistory(history.value?.page ?? 0))]), ...(history.value?.items.map(record => h('article', { class: 'opt-history-item' }, [h('div', [h('strong', `${record.restoring ? '恢复' : '调整'} · ${recordState(record.status)}`), h('small', new Date(record.at).toLocaleString())]), h('ul', record.items.map(item => h('li', `${item.name} · ${recordState(item.status)}`))), button('预览恢复', () => restore(record.id))])) ?? []), history.value?.items.length === 0 ? h('p', { class: 'opt-empty' }, '尚无修改记录。') : null,
                        history.value ? h('footer', { class: 'opt-pagination' }, [button('较新记录', () => loadHistory(history.value.page - 1), false, history.value.page === 0), h('span', `共 ${history.value.total} 次`), button('较早记录', () => loadHistory(history.value.page + 1), false, (history.value.page + 1) * 20 >= history.value.total)]) : null,
                    ]) : null,
                    detail.value ? h('aside', { class: 'opt-detail', 'aria-label': '优化项目详情' }, [h('h2', detail.value.name), h('pre', detail.value.details), button('收起详情', () => { detail.value = undefined; })]) : null,
                    selected.value.size ? h('footer', { class: 'opt-action-bar' }, [h('span', `已选 ${selected.value.size} 项 · 尚未更改`), button('清除选择', () => { selected.value = new Set(); }), button('预览更改', prepare, true)]) : null,
                    h('dialog', { ref: previewDialog, class: 'opt-preview', 'aria-label': '确认优化更改', onCancel: (event) => { event.preventDefault(); if (!busy.value)
                            preview.value = undefined; } }, preview.value ? [h('header', [h('h2', preview.value.restoring ? '恢复预览' : '更改预览'), h('span', '可恢复 · 当前用户')]), ...preview.value.items.map(item => h('div', { class: 'opt-preview-row' }, [h('strong', item.name), h('span', `${item.before} → ${item.after}`), h('small', item.note)])), h('footer', [button('取消', () => { preview.value = undefined; }), button(`确认${preview.value.restoring ? '恢复' : '应用'} ${preview.value.items.length} 项`, apply, true)])] : []),
                    snapshot.value ? h('details', { class: 'opt-coverage' }, [h('summary', '扫描范围与限制'), h('p', '读取当前用户可访问的注册表登记、启动文件夹、自动服务、开机/登录任务，以及桌面与商店应用；权限受限来源会被跳过。'), h('p', '尚未覆盖应用启动任务，不推测签名、启动影响或优化收益。'), ...snapshot.value.warnings.filter(warning => !warning.startsWith('StartupApproved')).map(warning => h('p', warning.replace('Unable to read', '无法读取').replace('Service enumeration unavailable', '无法读取服务清单').replace('Scheduled task enumeration unavailable', '无法读取计划任务').replace('Application enumeration incomplete', '应用清单读取不完整').replace('Packaged applications unavailable', '无法读取商店应用').replace('Startup folder unavailable', '无法读取启动文件夹').replace('Setting unavailable:', '设置读取失败：').replace('Enumeration is bounded: 1000 entries per startup source and packaged apps, 2000 entries per desktop-app registry source, 10000 entries total. Larger sources may be incomplete.', '扫描有限额：启动来源及商店应用各最多 1,000 项，桌面应用注册表来源各最多 2,000 项，总计最多 10,000 项；超过限额的来源可能不完整。').replace('Total enumeration truncated at 10000 entries.', '总清单已截断至 10,000 项。')))]) : null,
                ]);
            },
        } });
}
