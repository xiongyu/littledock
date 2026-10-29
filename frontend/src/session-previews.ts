import { nextTick, onBeforeUnmount, ref } from 'vue'
import { selectSessionPreview, type PreviewFrame, type PreviewProtocol, type PreviewSession } from './session-preview'

/** Small in-memory thumbnails only; retain at most 100 stopped servers until page close. */
export function useSessionPreviews() {
  const sessions = ref<Record<string, PreviewSession & { serverId: string }>>({})
  const lastFrames = ref<Record<string, PreviewFrame>>({})
  const urls = new Set<string>()
  let disposed = false
  const forServer = (serverId: string) => Object.values(sessions.value).filter(item => item.serverId === serverId)
  function remember(serverId: string) {
    const selected = selectSessionPreview(forServer(serverId), lastFrames.value[serverId])
    if (selected.frame) lastFrames.value[serverId] = selected.frame
    const stopped = Object.keys(lastFrames.value).filter(id => !forServer(id).some(item => item.state === 'running'))
      .sort((a, b) => lastFrames.value[b]!.capturedAt - lastFrames.value[a]!.capturedAt)
    for (const id of stopped.slice(100)) delete lastFrames.value[id]
    void nextTick(() => {
      const referenced = new Set([...Object.values(sessions.value).map(item => item.frame?.objectUrl), ...Object.values(lastFrames.value).map(item => item.objectUrl)])
      for (const url of urls) if (disposed || !referenced.has(url)) { URL.revokeObjectURL(url); urls.delete(url) }
    })
  }
  function add(id: string, serverId: string, protocol: PreviewProtocol) { sessions.value[id] = { id, serverId, protocol, state: 'stopped', lastActivityAt: Date.now() } }
  function running(id: string, value: boolean) {
    const session = sessions.value[id]; if (!session) return
    remember(session.serverId); session.state = value ? 'running' : 'stopped'; session.lastActivityAt = Date.now(); remember(session.serverId)
  }
  function frame(id: string, blob: Blob) {
    const session = sessions.value[id]; if (!session || disposed || blob.size > 128 * 1024) return
    const objectUrl = URL.createObjectURL(blob); urls.add(objectUrl)
    session.frame = { sessionId: id, protocol: session.protocol, capturedAt: Date.now(), objectUrl }; remember(session.serverId)
  }
  function remove(id: string) {
    const session = sessions.value[id]; if (!session) return
    remember(session.serverId); delete sessions.value[id]; remember(session.serverId)
  }
  function activate(id: string) { const session = sessions.value[id]; if (session) { session.lastActivityAt = Date.now(); remember(session.serverId) } }
  function prune(serverIds: Set<string>) {
    for (const session of Object.values(sessions.value)) if (!serverIds.has(session.serverId)) session.frame = undefined
    for (const id of Object.keys(lastFrames.value)) if (!serverIds.has(id)) { delete lastFrames.value[id]; remember(id) }
  }
  onBeforeUnmount(() => { disposed = true; for (const url of urls) URL.revokeObjectURL(url); urls.clear() })
  return { forServer, lastFrames, add, running, frame, remove, activate, prune }
}
