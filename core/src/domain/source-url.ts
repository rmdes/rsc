// Canonical URL normalization for the v2 source-control plane
// (RSC_SOURCE_MODEL_V2, dormant). Deliberately narrow per design §3: normalize
// scheme/host and remove default ports, remove fragments; preserve path,
// query, trailing slash, and HTTP-vs-HTTPS. Reject credentials and URLs over
// 2048 characters.
const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }

export function normalizeSourceUrl(raw: string): string {
  if (raw.length > 2048) throw new Error('source URL invalid')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('source URL invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('source URL invalid')
  if (url.username || url.password) throw new Error('source URL invalid')
  const hostname = url.hostname.toLowerCase()
  // URL strips IPv6 brackets from .hostname; re-add them for reconstruction.
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  const port = url.port && url.port !== DEFAULT_PORT[url.protocol] ? `:${url.port}` : ''
  return `${url.protocol}//${host}${port}${url.pathname}${url.search}`
}
