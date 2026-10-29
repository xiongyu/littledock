export function publicSnapshot(snapshot) {
    const { identity: _identity, items, ...rest } = snapshot;
    return { ...rest, items: items.map(({ target: _target, before: _before, desired: _desired, details: _details, ...item }) => item) };
}
export const equivalent = (a, b) => a.exists === b.exists && (!a.exists || (b.exists && a.type === b.type && a.data === b.data));
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('系统数据格式无效。'); return value; }
function text(value, max = 32768) { if (typeof value !== 'string' || value.length > max)
    throw new Error('系统文本数据无效。'); return value; }
export function registryValue(input) {
    const v = object(input);
    if (v.exists === false)
        return { exists: false };
    if (v.exists !== true)
        throw new Error('注册表状态无效。');
    if (v.type === 'DWord' && Number.isInteger(v.data) && Number(v.data) >= -2147483648 && Number(v.data) <= 2147483647)
        return { exists: true, type: v.type, data: Number(v.data) };
    if (v.type === 'String' || v.type === 'ExpandString')
        return { exists: true, type: v.type, data: text(v.data) };
    throw new Error('不支持的注册表值类型。');
}
export function registryTarget(input) {
    const v = object(input);
    if (!['CurrentUser', 'LocalMachine'].includes(String(v.hive)) || !['Registry32', 'Registry64'].includes(String(v.view)))
        throw new Error('注册表范围无效。');
    return { hive: v.hive, view: v.view, path: text(v.path, 300), name: text(v.name, 300) };
}
export function parseSnapshot(input) {
    const s = object(input);
    if (!Number.isSafeInteger(s.build) || !Number.isSafeInteger(s.scannedAt) || !Array.isArray(s.items) || s.items.length > 10000 || !Array.isArray(s.coverage) || !Array.isArray(s.warnings))
        throw new Error('扫描响应超限或无效。');
    const items = s.items.map(input => {
        const i = object(input);
        if (!['startup', 'settings', 'apps'].includes(String(i.category)) || typeof i.writable !== 'boolean')
            throw new Error('扫描条目无效。');
        const item = { id: text(i.id, 160), name: text(i.name, 1000), category: i.category, source: text(i.source, 1000), state: text(i.state, 100), writable: i.writable, note: text(i.note, 2000) };
        if (i.target !== undefined)
            item.target = registryTarget(i.target);
        if (i.before !== undefined)
            item.before = registryValue(i.before);
        if (i.desired !== undefined)
            item.desired = registryValue(i.desired);
        if (i.details !== undefined)
            item.details = text(i.details);
        if (i.publisher !== undefined)
            item.publisher = text(i.publisher, 2000);
        if (i.version !== undefined)
            item.version = text(i.version, 200);
        if (item.writable && (!item.target || !item.before || !item.desired))
            throw new Error('可修改条目缺少原值。');
        return item;
    });
    if (new Set(items.map(item => item.id)).size !== items.length)
        throw new Error('扫描条目标识冲突。');
    return { identity: text(s.identity, 160), computer: text(s.computer, 300), user: text(s.user, 300), build: Number(s.build), scannedAt: Number(s.scannedAt), items, coverage: s.coverage.map(v => text(v, 2000)), warnings: s.warnings.map(v => text(v, 2000)) };
}
