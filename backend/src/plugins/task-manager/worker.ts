import type { WorkerService, WorkerServiceHost } from '../../plugin-system/service-worker.ts'
import { TaskManagerEngine } from './index.ts'
import { taskManagerMethods, type TaskManagerConfig, type TaskManagerHost } from './contract.ts'

export async function createService(host: WorkerServiceHost, config: TaskManagerConfig): Promise<WorkerService> {
  const api: TaskManagerHost = {
    authorize: owner => host.call('authorize', [owner]), available: () => host.call('available'),
    reserve: (owner, target) => host.call('reserve', [owner, target]), release: id => host.call('release', [id]),
    connection: (owner, id) => host.call('connection', [owner, id]), fingerprint: (owner, id, next) => host.call('fingerprint', [owner, id, next]),
    onLock: callback => host.onEvent(name => { if (name === 'lock') callback() }),
  }
  const engine = new TaskManagerEngine(api, config)
  return { methods: Object.fromEntries(taskManagerMethods.map(name => [name, engine[name].bind(engine)])), dispose: () => engine.dispose() }
}
