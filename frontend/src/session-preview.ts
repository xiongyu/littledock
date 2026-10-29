// Native RDP has no frame provider. Embedded desktop previews come from the actual display.
export type PreviewProtocol = 'ssh' | 'rdp' | 'vnc' | 'local' | 'adb' | 'wdb'

export interface PreviewFrame {
  sessionId: string
  protocol: PreviewProtocol
  objectUrl: string
  capturedAt: number
}

export interface PreviewSession {
  id: string
  protocol: PreviewProtocol
  state: 'running' | 'stopped'
  lastActivityAt: number
  frame?: PreviewFrame
}

export interface PreviewSelection {
  session?: PreviewSession
  frame?: PreviewFrame
  running: boolean
}

export const DEFAULT_PREVIEW_INTERVAL_MS = 5_000
const priority: Record<PreviewProtocol, number> = { vnc: 3, rdp: 2, ssh: 1, local: 1, adb: 4, wdb: 4 }

function matchingFrame(session: PreviewSession): PreviewFrame | undefined {
  return session.frame?.sessionId === session.id && session.frame.protocol === session.protocol
    ? session.frame : undefined
}

export function selectSessionPreview(
  sessions: readonly PreviewSession[],
  lastDisplayedFrame?: PreviewFrame,
): PreviewSelection {
  const session = sessions.filter(item => item.state === 'running').sort((a, b) =>
    priority[b.protocol] - priority[a.protocol]
    || b.lastActivityAt - a.lastActivityAt
    || a.id.localeCompare(b.id),
  )[0]

  if (session) {
    const retainedFrame = lastDisplayedFrame?.sessionId === session.id
      && lastDisplayedFrame.protocol === session.protocol ? lastDisplayedFrame : undefined
    const currentFrame = matchingFrame(session)
    const frame = retainedFrame && (!currentFrame || retainedFrame.capturedAt > currentFrame.capturedAt)
      ? retainedFrame : currentFrame
    return { session, frame, running: true }
  }

  // Once all sessions stop, retain what the user last saw rather than choosing
  // a different protocol's historical frame merely because it has higher rank.
  const latestFrame = sessions.map(matchingFrame).filter((frame): frame is PreviewFrame => !!frame)
    .sort((a, b) => b.capturedAt - a.capturedAt)[0]
  return { frame: lastDisplayedFrame ?? latestFrame, running: false }
}
