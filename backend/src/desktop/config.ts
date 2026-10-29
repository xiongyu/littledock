import { createHash } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type RunMode = 'dev' | 'start'
export type RuntimeState = 'starting' | 'running' | 'restarting' | 'failed' | 'stopping'
export const root = fileURLToPath(new URL('../../../', import.meta.url))
export function configuration(mode: RunMode, env = process.env) {
  const port = Number(env.WEBNAV_PORT ?? 3030), uiPort = Number(env.WEBNAV_UI_PORT ?? 5173)
  for (const value of [port, uiPort]) if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('小站端口须为 1024–65535 的整数。')
  if (mode === 'dev' && port === uiPort) throw new Error('前后端开发端口不能相同。')
  const directory = resolve(env.WEBNAV_DATA_DIR ?? join(env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'WebNav'))
  // The application profile, not a checkout, port or selected database, owns the singleton.
  const profileDirectory = resolve(join(env.LOCALAPPDATA ?? env.XDG_STATE_HOME ?? join(homedir(), '.local', 'share'), 'WebNav'))
  const identity = createHash('sha256').update(userInfo().username + '\0' + (process.platform === 'win32' ? profileDirectory.toLowerCase() : profileDirectory)).digest('hex').slice(0, 20)
  const runtimeDirectory = join(profileDirectory, 'runtime')
  return {
    mode, port, uiPort, directory, identity, root,
    installRoot: env.WEBNAV_INSTALL_ROOT ? resolve(env.WEBNAV_INSTALL_ROOT) : undefined,
    url: `http://127.0.0.1:${mode === 'dev' ? uiPort : port}/`,
    runtimeDirectory,
    pipe: process.platform === 'win32' ? `\\\\.\\pipe\\webnav-${identity}` : join(runtimeDirectory, 'instance.sock'),
    environment: {
      WEBNAV_DATA_DIR: directory, WEBNAV_PORT: String(port), WEBNAV_UI_PORT: String(uiPort),
      ...(env.LOCALAPPDATA ? { LOCALAPPDATA: env.LOCALAPPDATA } : {}),
      ...(env.XDG_STATE_HOME ? { XDG_STATE_HOME: env.XDG_STATE_HOME } : {}),
      ...(env.WEBNAV_RDP_ENABLED ? { WEBNAV_RDP_ENABLED: env.WEBNAV_RDP_ENABLED } : {}),
      ...(env.WEBNAV_EDITOR_ENABLED ? { WEBNAV_EDITOR_ENABLED: env.WEBNAV_EDITOR_ENABLED } : {}),
      ...(env.WEBNAV_EDITOR_PACKAGE_DIR ? { WEBNAV_EDITOR_PACKAGE_DIR: env.WEBNAV_EDITOR_PACKAGE_DIR } : {}),
    },
  }
}
export type RuntimeConfig = ReturnType<typeof configuration>
