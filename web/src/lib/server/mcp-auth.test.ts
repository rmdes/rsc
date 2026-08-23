import { test, expect } from 'vitest'
import { bearer } from './mcp-auth.ts'

test('bearer() accepts the scheme case-insensitively, per RFC 7235', () => {
	expect(bearer(new Request('http://x', { headers: { authorization: 'bearer rsc_k' } }))).toBe('rsc_k')
	expect(bearer(new Request('http://x', { headers: { authorization: 'Bearer rsc_k' } }))).toBe('rsc_k')
	expect(bearer(new Request('http://x'))).toBe(null)
	expect(bearer(new Request('http://x', { headers: { authorization: 'Bearer\trsc_k' } }))).toBe('rsc_k')
	expect(bearer(new Request('http://x', { headers: { authorization: 'Bearer   rsc_k' } }))).toBe('rsc_k')
	// The Headers object joins repeated headers comma-separated (RFC 9110 5.3);
	// the combined value is not a valid Bearer challenge.
	expect(
		bearer(new Request('http://x', { headers: [['authorization', 'a'], ['authorization', 'Bearer b']] }))
	).toBe(null)
	expect(bearer(new Request('http://x', { headers: { authorization: 'Bearer Bearer x' } }))).toBe(null)
})
