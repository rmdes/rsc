import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('..', import.meta.url))
const m = JSON.parse(readFileSync(dir + '/CloudronManifest.json', 'utf8'))

test('manifest has the required Cloudron fields', () => {
  assert.equal(m.manifestVersion, 2)
  assert.equal(m.httpPort, 8000)
  assert.equal(m.healthCheckPath, '/')
  assert.ok(m.addons.localstorage, 'localstorage addon')
  assert.ok(m.addons.sendmail, 'sendmail addon')
  assert.ok(!m.addons.mongodb && !m.addons.postgresql, 'no db addon')
  assert.match(m.id, /^[a-z0-9.]+$/, 'reverse-DNS id')
  assert.ok(m.version && m.title && m.author)
})

test('logo.png exists and is non-empty', () => {
  const s = statSync(dir + '/logo.png')
  assert.ok(s.size > 0)
})
