import type { FeedDiscovery } from './ingest.ts'
import type { PushProtocol } from './types.ts'

export interface PushTarget { mode: PushProtocol; endpoint: string; topic: string }

export function choosePushTarget(discovery: FeedDiscovery, feedUrl: string): PushTarget | null {
  if (discovery.hubs.length > 0) {
    return { mode: 'websub', endpoint: discovery.hubs[0], topic: discovery.self ?? feedUrl }
  }
  if (discovery.cloud && discovery.cloud.protocol === 'http-post') {
    const { domain, port, path } = discovery.cloud
    return { mode: 'rsscloud', endpoint: `http://${domain}:${port}${path}`, topic: feedUrl }
  }
  return null
}
