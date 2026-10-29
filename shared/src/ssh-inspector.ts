export interface SshSystemInfo {
  hostname: string; platform: string; uptime: number; cpuCount: number; cpuPercent: number | null;
  memoryTotal: number; memoryUsed: number; load: string;
  disks: { path: string; total: number; used: number }[]; sampledAt: number
}
export interface SshFileEntry { name: string; kind: 'directory' | 'file' | 'link'; size: number; modifiedAt: number; permissions: string; owner: string }
export interface SshFilePage { path: string; entries: SshFileEntry[]; offset: number; total: number; truncated: boolean }
