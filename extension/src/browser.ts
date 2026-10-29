/** The small promise-based MV3 API surface used by both Chromium and Firefox builds. */
export interface BrowserTab { id?: number; url?: string; title?: string; active?: boolean }
export interface MessageSender { id?: string; url?: string; origin?: string; frameId?: number; tab?: BrowserTab }
type Listener = (message: unknown, sender: MessageSender, respond: (result: unknown) => void) => boolean | void
interface Script { id: string; matches: string[]; js: string[]; runAt: 'document_idle'; allFrames: false; persistAcrossSessions: boolean }
export interface BrowserApi {
  runtime: {
    id: string
    getURL(path: string): string
    sendMessage(message: unknown): Promise<unknown>
    onMessage: { addListener(listener: Listener): void }
    onInstalled: { addListener(listener: () => void): void }
    onStartup: { addListener(listener: () => void): void }
  }
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<BrowserTab[]>
    get(id: number): Promise<BrowserTab>
    create(options: { url: string }): Promise<BrowserTab>
    sendMessage(id: number, message: unknown, options: { frameId: number }): Promise<unknown>
  }
  scripting: {
    executeScript(options: { target: { tabId: number; frameIds: number[] }; files: string[] }): Promise<unknown>
    registerContentScripts(scripts: Script[]): Promise<void>
    getRegisteredContentScripts(): Promise<Script[]>
    unregisterContentScripts(options: { ids: string[] }): Promise<void>
  }
  permissions: {
    request(options: { origins: string[] }): Promise<boolean>
    contains(options: { origins: string[] }): Promise<boolean>
    onRemoved: { addListener(listener: () => void): void }
  }
}
const platform = globalThis as typeof globalThis & { browser?: BrowserApi; chrome?: BrowserApi }
export const browser = (platform.browser ?? platform.chrome)!
