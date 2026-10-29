import { i18n } from "./localization.js";
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { equivalent, publicSnapshot, registryTarget, registryValue } from "./model.js";
/** One scan/write at a time; plans freeze exact original values and do not contain executable text. */
export class OptimizerEngine {
    snapshot;
    plans = new Map();
    busy = false;
    records = new Map();
    recordIds = new Set();
    closed = false;
    adapter;
    directory;
    lease;
    unlocked;
    constructor(adapter, directory, lease, unlocked) { this.adapter = adapter; this.directory = directory; this.lease = lease; this.unlocked = unlocked; }
    async initialize() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const files = (await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}\.protected$/.test(name));
        if (files.length > 1000)
            throw i18n.error('PLUGIN_FAILED', 'm17e32bb34896');
        this.recordIds = new Set(files.map(file => file.replace('.protected', '')));
    }
    async record(id) {
        if (this.records.has(id))
            return this.records.get(id);
        if (!this.recordIds.has(id))
            throw i18n.error('PLUGIN_FAILED', 'mb1c4ecaf8671');
        const file = id + '.protected', path = join(this.directory, file);
        if ((await stat(path)).size > 2 * 1024 * 1024)
            throw i18n.error('PLUGIN_FAILED', 'm856c2bfae90a');
        const encoded = await readFile(path, 'utf8');
        const record = JSON.parse(await this.adapter.unprotect(encoded));
        if (record.id + '.protected' !== file || record.operationId !== id || typeof record.request !== 'string' || !/^[a-f0-9]{64}$/.test(record.request) || typeof record.owner !== 'string' || typeof record.identity !== 'string' || !Number.isSafeInteger(record.createdAt) || !['running', 'complete', 'partial', 'unknown'].includes(record.status) || !Array.isArray(record.items) || record.items.length > 50)
            throw i18n.error('PLUGIN_FAILED', 'mce883736ac33');
        for (const item of record.items) {
            if (typeof item.name !== 'string' || item.name.length > 1000 || !['pending', 'applied', 'conflict', 'failed', 'unknown'].includes(item.status))
                throw i18n.error('PLUGIN_FAILED', 'm9902392a1fe7');
            item.target = registryTarget(item.target);
            item.before = registryValue(item.before);
            item.after = registryValue(item.after);
        }
        if (record.status === 'running') {
            record.status = 'unknown';
            for (const item of record.items)
                if (item.status === 'pending')
                    item.status = 'unknown';
        }
        this.records.set(record.id, record);
        if (this.records.size > 40)
            this.records.delete(this.records.keys().next().value);
        return record;
    }
    async available() { if (this.closed || !await this.unlocked())
        throw i18n.error('PLUGIN_FAILED', 'mbe59a4703030'); if (this.busy)
        throw i18n.error('PLUGIN_FAILED', 'md41e4f279c68'); }
    async exclusive(action) {
        if (this.closed || this.busy)
            throw i18n.error('PLUGIN_FAILED', 'mc0fca015100a');
        this.busy = true;
        let release;
        try {
            release = await this.lease();
            if (this.closed || !await this.unlocked())
                throw i18n.error('PLUGIN_FAILED', 'mbe59a4703030');
            return await action();
        }
        finally {
            this.busy = false;
            release?.();
        }
    }
    async scan() { return this.exclusive(async () => { this.snapshot = await this.adapter.snapshot(); return publicSnapshot(this.snapshot); }); }
    async details(id) { await this.available(); const item = this.snapshot?.items.find(item => item.id === id); if (!item)
        throw i18n.error('PLUGIN_FAILED', 'mda6b86295313'); return { name: item.name, details: item.details ?? item.note }; }
    async preview(owner, ids) {
        return this.exclusive(async () => {
            if (!this.snapshot || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
                throw i18n.error('PLUGIN_FAILED', 'm67ff18c14813');
            const changes = [];
            for (const id of ids) {
                const item = this.snapshot.items.find(item => item.id === id);
                if (!item?.writable || !item.target || !item.before || !item.desired)
                    throw i18n.error('PLUGIN_FAILED', 'm26d1f9489127');
                const current = await this.adapter.read(item.target);
                if (!equivalent(current, item.before))
                    throw i18n.error('PLUGIN_FAILED', 'mea8933e81629', { p0: (item.name) });
                changes.push({ itemId: id, name: item.name, target: item.target, before: current, after: item.desired, note: item.category === 'startup' ? i18n.text('mc25c63b56b21') : item.note });
            }
            return this.plan(owner, this.snapshot.identity, changes);
        });
    }
    plan(owner, identity, changes, restorationOf) {
        for (const [id, plan] of this.plans)
            if (plan.expiresAt < Date.now())
                this.plans.delete(id);
        if (this.plans.size >= 32)
            throw i18n.error('PLUGIN_FAILED', 'mcca8400ff831');
        const plan = { id: randomUUID(), owner, identity, expiresAt: Date.now() + 300000, changes, ...(restorationOf ? { restorationOf } : {}) };
        this.plans.set(plan.id, plan);
        const describe = (value) => !value.exists ? i18n.message('m4e51b67dd32c') : typeof value.data === 'number' ? String(value.data) : i18n.message('m57e78d77116f');
        return { id: plan.id, expiresAt: plan.expiresAt, restoring: !!restorationOf, items: changes.map(item => ({ itemId: item.itemId, name: item.name, before: describe(item.before), after: describe(item.after), note: restorationOf ? i18n.message('m249f75fc2b09') : item.target.path.endsWith('Run') ? i18n.message('mc25c63b56b21') : i18n.message(`rules.${item.itemId}.note`) })), reversible: true };
    }
    async restorePreview(owner, id) {
        return this.exclusive(async () => {
            const record = await this.record(id);
            const current = await this.adapter.snapshot();
            if (current.identity !== record.identity)
                throw i18n.error('PLUGIN_FAILED', 'm672f9e61df06');
            const changes = [];
            for (const item of record.items)
                if (item.status === 'applied' || item.status === 'unknown') {
                    const value = await this.adapter.read(item.target);
                    if (equivalent(value, item.before))
                        continue;
                    if (!equivalent(value, item.after))
                        throw i18n.error('PLUGIN_FAILED', 'md1aaedaf140a', { p0: (item.name) });
                    changes.push({ ...item, before: item.after, after: item.before, note: i18n.text('m249f75fc2b09') });
                }
            if (!changes.length)
                throw i18n.error('PLUGIN_FAILED', 'm2891f137cc55');
            return this.plan(owner, record.identity, changes, id);
        });
    }
    async apply(owner, planId, operationId) {
        if (!/^[a-f0-9-]{36}$/.test(operationId))
            throw i18n.error('PLUGIN_FAILED', 'm05055c2ac30d');
        const request = createHash('sha256').update(owner + '/' + planId).digest('hex');
        const previous = this.recordIds.has(operationId) ? await this.record(operationId) : undefined;
        if (previous) {
            if (previous.request !== request)
                throw i18n.error('PLUGIN_FAILED', 'm570fa7edc5d5');
            return this.summary(previous);
        }
        return this.exclusive(async () => {
            const plan = this.plans.get(planId);
            if (!plan || plan.owner !== owner || plan.expiresAt < Date.now())
                throw i18n.error('PLUGIN_FAILED', 'mc5e916abdb56');
            if (this.recordIds.size >= 1000)
                throw i18n.error('PLUGIN_FAILED', 'mc8c4e18a9e40');
            const current = await this.adapter.snapshot();
            if (current.identity !== plan.identity)
                throw i18n.error('PLUGIN_FAILED', 'm73dd113c9292');
            const record = { id: operationId, operationId, request, owner, identity: plan.identity, createdAt: Date.now(), status: 'running', items: plan.changes.map(item => ({ ...item, status: 'pending' })), ...(plan.restorationOf ? { restorationOf: plan.restorationOf } : {}) };
            // Save encrypted recovery material before any registry mutation.
            await this.persist(record);
            this.records.set(record.id, record);
            this.recordIds.add(record.id);
            this.plans.delete(planId);
            if (this.records.size > 40)
                this.records.delete(this.records.keys().next().value);
            for (const item of record.items) {
                if (!await this.unlocked())
                    break;
                try {
                    const result = await this.adapter.apply(item.target, item.before, item.after);
                    item.status = result.status;
                    if (result.status === 'applied' && !equivalent(result.current, item.after))
                        item.status = 'unknown';
                }
                catch {
                    item.status = 'unknown';
                    item.message = i18n.text('m179b738a3269');
                }
                try {
                    await this.persist(record);
                }
                catch {
                    record.status = 'unknown';
                    throw i18n.error('PLUGIN_FAILED', 'm3e9603dd6676');
                }
                if (item.status !== 'applied')
                    break;
            }
            record.status = record.items.every(item => item.status === 'applied') ? 'complete' : 'partial';
            await this.persist(record);
            return this.summary(record);
        });
    }
    async persist(record) {
        const text = JSON.stringify(record);
        if (Buffer.byteLength(text) > 1024 * 1024)
            throw i18n.error('PLUGIN_FAILED', 'm7dfa812f022d');
        const encoded = await this.adapter.protect(text), path = join(this.directory, record.id + '.protected'), temporary = path + '.tmp';
        const bytes = (await Promise.all([...this.recordIds].filter(id => id !== record.id).map(async (id) => (await stat(join(this.directory, id + '.protected'))).size))).reduce((sum, size) => sum + size, 0);
        if (bytes + Buffer.byteLength(encoded) + 4096 > 100 * 1024 * 1024)
            throw i18n.error('PLUGIN_FAILED', 'm0e3e6618bd34');
        await writeFile(temporary, encoded, { mode: 0o600, flush: true });
        await rename(temporary, path);
    }
    summary(record) { return { id: record.id, at: record.createdAt, status: record.status, restoring: !!record.restorationOf, items: record.items.map(item => ({ itemId: item.itemId, name: item.name, status: item.status, message: item.message })) }; }
    async history(page = 0) {
        if (!Number.isSafeInteger(page) || page < 0 || page > 49)
            throw i18n.error('PLUGIN_FAILED', 'm61d404c32211');
        const files = await Promise.all([...this.recordIds].map(async (id) => ({ id, modified: (await stat(join(this.directory, id + '.protected'))).mtimeMs })));
        const result = [];
        for (const file of files.sort((a, b) => b.modified - a.modified).slice(page * 20, page * 20 + 20))
            result.push(this.summary(await this.record(file.id)));
        return { total: files.length, page, items: result };
    }
    get active() { return this.busy; }
    async close() { this.closed = true; this.plans.clear(); this.snapshot = undefined; await this.adapter.close(); }
}
