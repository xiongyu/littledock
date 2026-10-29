import type { Duplex } from 'node:stream'

/** Optional v1 capability: retain the remote connection and recreate display state per viewer. */
export type DesktopStream = Duplex & { viewerVersion?: 1; setViewer?: (attached: boolean) => void }
