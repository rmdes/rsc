import { test, expect } from 'vitest'
import { isPrivateIp, checkCallbackUrl } from '../src/domain/push-guard.ts'

const publicLookup = async () => ({ address: '93.184.216.34' })
const privateLookup = async () => ({ address: '10.0.0.5' })

test('isPrivateIp classifies the RFC ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1']) {
    expect(isPrivateIp(ip), ip).toBe(true)
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '172.32.0.1']) {
    expect(isPrivateIp(ip), ip).toBe(false)
  }
})

test('checkCallbackUrl accepts a public host and reports it', async () => {
  const r = await checkCallbackUrl('https://cb.example.com/receive', publicLookup)
  expect(r).toEqual({ ok: true, host: 'cb.example.com' })
})

test('checkCallbackUrl rejects non-http, localhost names, literal and resolved private IPs', async () => {
  expect((await checkCallbackUrl('ftp://cb.example.com/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://localhost:9/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://evil.localhost/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://127.0.0.1/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://[::1]/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('https://rebound.example.com/x', privateLookup)).ok).toBe(false)
})

test('checkCallbackUrl rejects when DNS resolution fails', async () => {
  const failing = async () => { throw new Error('ENOTFOUND') }
  expect((await checkCallbackUrl('https://nx.example.com/x', failing)).ok).toBe(false)
})

test('v4-mapped IPv6 literals cannot bypass the guard (URL canonicalizes to hex groups)', async () => {
  // URL turns ::ffff:127.0.0.1 into ::ffff:7f00:1 — the guard must catch BOTH forms
  expect(isPrivateIp('::ffff:7f00:1')).toBe(true) // 127.0.0.1
  expect(isPrivateIp('::ffff:a00:5')).toBe(true) // 10.0.0.5
  expect(isPrivateIp('::ffff:c0a8:101')).toBe(true) // 192.168.1.1
  expect(isPrivateIp('::ffff:5db8:d822')).toBe(false) // 93.184.216.34, public
  expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true) // dotted form still handled
  expect((await checkCallbackUrl('http://[::ffff:127.0.0.1]/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://[::ffff:10.0.0.5]/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://[::ffff:5db8:d822]/x', publicLookup)).ok).toBe(true)
})
