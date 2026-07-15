import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type LookupFn = (hostname: string) => Promise<{ address: string }>

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  const v6 = ip.toLowerCase()
  if (v6 === '::1' || v6 === '::') return true
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true // ULA fc00::/7
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true // link-local fe80::/10
  if (v6.startsWith('::ffff:')) {
    const rest = v6.slice(7)
    if (isIP(rest) === 4) return isPrivateIp(rest) // dotted-quad form
    // URL canonicalizes mapped addresses to hex-group form (::ffff:7f00:1);
    // decode the two 16-bit groups back into a dotted quad.
    const groups = rest.split(':')
    if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = parseInt(groups[0], 16)
      const lo = parseInt(groups[1], 16)
      return isPrivateIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
    }
    return true // unrecognized mapped form: fail closed
  }
  return false
}

// SSRF gate for subscriber callbacks (spec H2 rule 2). Resolution happens at
// registration only; the rebinding residual is an accepted, ledgered decision.
export async function checkCallbackUrl(raw: string, lookupFn: LookupFn = lookup): Promise<{ ok: true; host: string } | { ok: false; reason: string }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'callback is not a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'callback must be http(s)' }
  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'callback host is local' }
  if (isIP(host)) {
    if (isPrivateIp(host)) return { ok: false, reason: 'callback host is private' }
    return { ok: true, host }
  }
  try {
    const { address } = await lookupFn(host)
    if (isPrivateIp(address)) return { ok: false, reason: 'callback host resolves to a private address' }
  } catch {
    return { ok: false, reason: 'callback host does not resolve' }
  }
  return { ok: true, host }
}
