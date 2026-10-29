export const terminalColorKeys = ['background', 'foreground', 'cursor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
export type TerminalColors = Record<typeof terminalColorKeys[number], string>
export interface TerminalTheme { id: string; name: string; colors: TerminalColors }
export interface TerminalThemeSettings { revision: number; defaultId: string; themes: TerminalTheme[] }
const ansi = ['#263238', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dce7e1', '#697b75', '#ff8790', '#b0dc90', '#ffdb91', '#87c7ff', '#df9bff', '#7dd4df', '#ffffff']
function preset(id: string, name: string, base: string[]): TerminalTheme {
  return { id, name, colors: Object.fromEntries(terminalColorKeys.map((key, index) => [key, [...base, ...ansi][index]!])) as TerminalColors }
}
export const builtInTerminalThemes: readonly TerminalTheme[] = [
  preset('forest', '静谧森林', ['#17201d', '#dce7e1', '#bbd6c7', '#425e50']),
  preset('midnight', '午夜蓝', ['#101827', '#d5deec', '#82aaff', '#344664']),
  preset('graphite', '石墨灰', ['#202124', '#e4e4e7', '#f0f0f0', '#4c4d53']),
  { ...preset('paper', '暖纸白', ['#f5f2ea', '#303b36', '#305d4c', '#c6d5cb']), colors: { ...preset('', '', ['#f5f2ea', '#303b36', '#305d4c', '#c6d5cb']).colors, red: '#a52e3b', green: '#356a36', yellow: '#8b6100', blue: '#225da8', magenta: '#8149a3', cyan: '#216d78', white: '#586861', brightWhite: '#303b36' } },
]
export function defaultTerminalThemes(): TerminalThemeSettings { return { revision: 0, defaultId: 'forest', themes: [] } }
export function parseTerminalThemes(input: unknown): TerminalThemeSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('终端配色格式不正确。')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['revision', 'defaultId', 'themes'].includes(key)) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.themes) || value.themes.length > 64) throw new Error('终端配色数量或版本无效。')
  const ids = new Set(builtInTerminalThemes.map(theme => theme.id))
  const themes = value.themes.map((entry: unknown): TerminalTheme => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('配色格式无效。')
    const theme = entry as Record<string, unknown>
    if (Object.keys(theme).some(key => !['id', 'name', 'colors'].includes(key)) || typeof theme.id !== 'string' || !/^[\w-]{1,80}$/.test(theme.id) || ids.has(theme.id) || typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 40) throw new Error('配色名称或标识无效。')
    ids.add(theme.id)
    if (!theme.colors || typeof theme.colors !== 'object' || Array.isArray(theme.colors)) throw new Error('请填写完整配色。')
    const colors = theme.colors as Record<string, unknown>
    if (Object.keys(colors).length !== terminalColorKeys.length || terminalColorKeys.some(key => typeof colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(colors[key] as string))) throw new Error('颜色必须为六位十六进制色值。')
    return { id: theme.id, name: theme.name.trim(), colors: { ...colors } as TerminalColors }
  })
  if (typeof value.defaultId !== 'string' || !ids.has(value.defaultId)) throw new Error('默认配色不存在。')
  return { revision: value.revision as number, defaultId: value.defaultId, themes }
}
export function resolveTerminalTheme(settings: TerminalThemeSettings, id?: string): TerminalTheme {
  const themes = [...builtInTerminalThemes, ...settings.themes]
  return themes.find(theme => theme.id === id) ?? themes.find(theme => theme.id === settings.defaultId) ?? builtInTerminalThemes[0]!
}
