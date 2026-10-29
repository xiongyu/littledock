import type { Connection } from './catalog.js'

export const localShells = { auto: '跟随本机系统', powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', cmd: '命令提示符（CMD）', bash: 'Bash', zsh: 'Zsh', sh: 'POSIX Shell' } as const
export type LocalShell = keyof typeof localShells
export function builtinConnectionSettings(connection: Pick<Connection, 'type' | 'pluginSettings'>) {
  const settings = connection.pluginSettings ?? {}
  const allowed: Record<string, string[]> = { local: ['shell', 'cwd'], adb: ['transport', 'serial', 'fps', 'mode', 'maxSize', 'maxFps', 'bitRate'], wdb: ['https'] }
  if (allowed[connection.type] && Object.keys(settings).some(key => !allowed[connection.type]!.includes(key))) throw new Error('此内置连接包含不支持的配置；密码不能写入公开配置。')
  const shell = settings.shell ?? 'auto', cwd = settings.cwd ?? ''
  const transport = settings.transport ?? 'usb', serial = settings.serial ?? '', fps = settings.fps ?? 2
  if (connection.type === 'local') {
    if (typeof shell !== 'string' || !Object.hasOwn(localShells, shell)) throw new Error('请选择支持的本地 Shell。')
    if (typeof cwd !== 'string' || cwd.length > 2048 || /[\x00-\x1f]/.test(cwd)) throw new Error('本地工作目录格式不正确。')
  }
  if (connection.type === 'adb') {
    if(settings.mode!==undefined&&!['scrcpy','screenshot'].includes(String(settings.mode)))throw new Error('ADB 控制模式不正确。')
    for(const [key,min,max] of [['maxSize',320,2560],['maxFps',10,120],['bitRate',1,20]] as const)if(settings[key]!==undefined&&(typeof settings[key]!=='number'||!Number.isInteger(settings[key])||settings[key]<min||settings[key]>max))throw new Error('scrcpy 画面设置超出支持范围。')
    if (!['usb', 'tcp'].includes(String(transport))) throw new Error('ADB 连接方式不正确。')
    if (typeof serial !== 'string' || (serial !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(serial))) throw new Error('ADB 设备序列号格式不正确。')
    if (typeof fps !== 'number' || !Number.isInteger(fps) || fps < 1 || fps > 5) throw new Error('ADB 截图频率为每秒 1 到 5 帧。')
  }
  if (connection.type === 'wdb' && settings.https !== undefined && typeof settings.https !== 'boolean') throw new Error('WDB HTTPS 选项不正确。')
  return { shell: shell as LocalShell, cwd: cwd as string, transport: transport as 'usb' | 'tcp', serial: serial as string, fps: fps as number, https: settings.https === true, mode:(settings.mode??'scrcpy') as 'scrcpy'|'screenshot',maxSize:Number(settings.maxSize??1280),maxFps:Number(settings.maxFps??60),bitRate:Number(settings.bitRate??8) }
}
