import { createConnection } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeConfig, RuntimeState } from './config.ts'
import type { SessionCounts } from './session-status.ts'

export type Status = { state: RuntimeState; url: string; pid: number; workerPid?: number; autoStart: boolean; presentation?: 'tray' | 'console'; reused?: boolean; error?: string; sessions?:SessionCounts; sessionSummary?:string }
export type Command = 'status' | 'restart' | 'exit' | 'open'
export async function request(config: RuntimeConfig, command: Command): Promise<Status> {
  const descriptor: unknown = JSON.parse(await readFile(join(config.runtimeDirectory, 'instance.json'), 'utf8'))
  if (!descriptor || typeof descriptor !== 'object' || !('token' in descriptor) || typeof descriptor.token !== 'string') throw new Error('无效的运行状态。')
  const token = descriptor.token
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.pipe)
    let buffer = ''
    socket.setTimeout(command === 'open' ? 20_000 : 3000, () => socket.destroy(new Error('工作台实例没有响应。')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ token, command }) + '\n'))
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 8192) return socket.destroy(new Error('无效的托盘响应。'))
      if (!buffer.includes('\n')) return
      try { resolve(JSON.parse(buffer.split('\n')[0]!) as Status) } catch (error) { reject(error) }
      socket.end()
    })
    socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('托盘连接已关闭。')) })
  })
}

/** A user-set environment flag alone cannot bypass the startup owner. */
export async function managedWorker(config:RuntimeConfig):Promise<boolean>{
  if(process.env.WEBNAV_MANAGED!=='1'||!process.send)return false
  const owner=await request(config,'status')
  if(owner.pid!==process.ppid||owner.workerPid!==process.pid)throw new Error('工作台工作进程不属于当前实例。')
  return true
}
