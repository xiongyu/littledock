import { Service, type Context } from 'cordis'
import { defaultTerminalThemes, parseTerminalThemes, type TerminalThemeSettings } from '@webnav/shared'
import { AppError } from '../core/errors.ts'

declare module 'cordis' { interface Context { terminalThemes: TerminalThemeService } }
export class TerminalThemeService extends Service {
  static inject = ['storage']
  private listeners = new Set<() => void>()
  constructor(ctx: Context) { super(ctx, 'terminalThemes', true); ctx.on('dispose', () => this.listeners.clear()) }
  snapshot(): TerminalThemeSettings {
    const saved = this.ctx.storage.getSetting('terminal-themes')
    return saved ? parseTerminalThemes(JSON.parse(saved)) : defaultTerminalThemes()
  }
  save(input: unknown) {
    let next: TerminalThemeSettings
    try { next = parseTerminalThemes(input) } catch (error) { throw new AppError('INVALID_ARGUMENT', error instanceof Error ? error.message : '配色无效。') }
    const current = this.snapshot()
    if (next.revision !== current.revision) throw new AppError('REVISION_CONFLICT', '配色已在其他页面修改，请重新打开后编辑。')
    next.revision++
    this.ctx.storage.setSetting('terminal-themes', JSON.stringify(next))
    for (const listener of this.listeners) listener()
    return next
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  replaceForSync(input: Omit<TerminalThemeSettings, 'revision'>) { const next = parseTerminalThemes({ ...input, revision: this.snapshot().revision + 1 }); this.ctx.storage.setSetting('terminal-themes', JSON.stringify(next)) }
  notifySync() { for (const listener of this.listeners) listener() }
}
