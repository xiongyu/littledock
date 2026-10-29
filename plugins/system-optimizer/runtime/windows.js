import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { release } from 'node:os';
import { parseSnapshot, registryValue } from "./model.js";
const script = fileURLToPath(new URL('../windows/bridge.ps1', import.meta.url));
const rules = fileURLToPath(new URL('../windows/rules.json', import.meta.url));
const scriptHash = '0bc45303174ba6b23647a74d9a307160676eb98542d8060ee0df54a0dc7cb1f3';
export class NativeWindowsAdapter {
    children = new Set();
    closed = false;
    async call(request, timeout = 30000) {
        if (this.closed || process.platform !== 'win32' || process.arch !== 'x64' || Number(release().split('.')[2]) < 22000)
            throw new Error('首版仅支持本机 Windows 11 x64。');
        if (createHash('sha256').update(await readFile(script)).update('\0').update(await readFile(rules)).digest('hex') !== scriptHash)
            throw new Error('Windows 助手或规则校验失败，请重新构建或安装插件。');
        if (this.children.size >= 2)
            throw new Error('Windows 助手正在处理其他请求。');
        const payload = JSON.stringify(request);
        if (Buffer.byteLength(payload) > 2 * 1024 * 1024)
            throw new Error('助手请求过大。');
        const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        return new Promise((resolve, reject) => {
            const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            this.children.add(child);
            let output = Buffer.alloc(0), failed = '', exited = false;
            const timer = setTimeout(() => { failed = 'Windows 助手超时；如有写入请通过恢复记录核对。'; child.kill(); }, timeout);
            child.stdout.on('data', (chunk) => { if (output.length + chunk.length > 4 * 1024 * 1024) {
                failed = '助手输出超限。';
                child.kill();
            }
            else
                output = Buffer.concat([output, chunk]); });
            child.stderr.resume(); // Never surface registry commands or values through logs.
            child.on('error', () => { failed = '无法启动 Windows 助手。'; });
            child.on('close', code => {
                exited = true;
                clearTimeout(timer);
                this.children.delete(child);
                if (failed)
                    return reject(new Error(failed));
                if (code !== 0)
                    return reject(new Error('Windows 助手执行失败，请核对当前状态。'));
                try {
                    const result = JSON.parse(output.toString('utf8').replace(/^\uFEFF/, ''));
                    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('data' in result))
                        throw new Error();
                    resolve(result.data);
                }
                catch {
                    reject(new Error('Windows 助手未返回有效结果。'));
                }
            });
            child.stdin.on('error', () => { if (!exited) {
                failed = 'Windows 助手输入失败。';
                child.kill();
            } });
            child.stdin.end(payload);
        });
    }
    async snapshot() {
        return parseSnapshot(await this.call({ op: 'snapshot' }));
    }
    async read(target) { return registryValue(await this.call({ op: 'read', target })); }
    async apply(target, expected, desired) {
        const result = await this.call({ op: 'apply', target, expected, desired });
        if (!result || typeof result !== 'object' || !('status' in result) || !['applied', 'conflict'].includes(String(result.status)) || !('current' in result))
            throw new Error('写入结果格式无效，请通过恢复记录核对。');
        return { status: result.status, current: registryValue(result.current) };
    }
    async protectedText(op, value) {
        const result = await this.call({ op, value });
        if (typeof result !== 'string' || result.length > 2 * 1024 * 1024)
            throw new Error('恢复材料格式无效。');
        return result;
    }
    protect(value) { return this.protectedText('protect', value); }
    unprotect(value) { return this.protectedText('unprotect', value); }
    async openSettings(page) { await this.call({ op: 'open-settings', page }); }
    async close() { this.closed = true; for (const child of this.children)
        child.kill(); await Promise.allSettled([...this.children].map(child => new Promise(resolve => { if (child.exitCode !== null)
        resolve();
    else
        child.once('close', () => resolve()); }))); }
}
