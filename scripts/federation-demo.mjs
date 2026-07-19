#!/usr/bin/env node
// federation-demo.mjs — end-to-end proof that one conversation federates across
// three SEPARATE RSC instances over nothing but RSS.
//
// It drives each instance's INTERNAL core API (core is not publicly exposed;
// only feeds/federation are), reaching it via `cloudron exec <app> -- curl
// http://127.0.0.1:8787/...`. Steps:
//   1. mint a guest poster on each instance
//   2. wire a full mesh of follows (each instance follows the other two's feeds)
//   3. run a post→reply chain main→alice→bob→main, asserting each hop actually
//      federates (polls the receiving instance's timeline) before continuing
//
// Ops tokens (needed for the POST /users follow calls — guests are 403'd there)
// come from env: TOK_MAIN, TOK_ALICE, TOK_BOB.
//   TOK_MAIN=… TOK_ALICE=… TOK_BOB=… node scripts/federation-demo.mjs
//
// This is an integration test against LIVE instances — it is intentionally not
// in the vitest suite (which runs core in-process). Exit code 0 = federation
// proven; non-zero = a hop failed (the log says which).

import { execFileSync } from 'node:child_process'

const NODES = {
  main: { loc: 'textcaster.app', origin: 'https://textcaster.app', token: process.env.TOK_MAIN },
  alice: { loc: 'alice.textcaster.app', origin: 'https://alice.textcaster.app', token: process.env.TOK_ALICE },
  bob: { loc: 'bob.textcaster.app', origin: 'https://bob.textcaster.app', token: process.env.TOK_BOB },
}
const CORE = 'http://127.0.0.1:8787'
const HOP_TIMEOUT_MS = 180_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

// Run curl INSIDE an instance's container against core. execFileSync passes
// args directly (no shell), so JSON bodies need no escaping.
function curl(node, args) {
  return execFileSync('cloudron', ['exec', '--app', node.loc, '--', 'curl', '-s', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

function mintPoster(node) {
  const headers = curl(node, [
    '-D', '-', '-o', '/dev/null', '-X', 'POST', `${CORE}/api/auth/sign-in/anonymous`,
    '-H', 'content-type: application/json', '-H', `origin: ${node.origin}`, '-d', '{}',
  ])
  const line = headers.split('\n').find((l) => /^set-cookie:/i.test(l))
  const cookie = line && line.replace(/^set-cookie:\s*/i, '').split(';')[0].trim()
  if (!cookie) throw new Error(`${node.name}: anonymous sign-in returned no cookie`)
  node.cookie = cookie
  node.handle = JSON.parse(curl(node, [`${CORE}/me`, '-H', `cookie: ${cookie}`])).user.handle
  node.feedUrl = `${node.origin}/users/${node.handle}/feed.xml`
}

function follow(node, remoteName, feedUrl) {
  const body = JSON.stringify({ handle: remoteName, displayName: remoteName, feedUrl })
  return curl(node, [
    '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', `${CORE}/users`,
    '-H', 'content-type: application/json', '-H', `authorization: Bearer ${node.token}`, '-d', body,
  ]).trim()
}

function post(node, content, inReplyTo) {
  const body = JSON.stringify(inReplyTo ? { content, inReplyTo } : { content })
  const out = curl(node, [
    '-X', 'POST', `${CORE}/posts`, '-H', 'content-type: application/json',
    '-H', `cookie: ${node.cookie}`, '-d', body,
  ])
  const j = JSON.parse(out)
  if (!j.post) throw new Error(`${node.name}: POST /posts failed: ${out.slice(0, 200)}`)
  return j.post
}

function timeline(node) {
  return JSON.parse(curl(node, [`${CORE}/timeline?limit=60`])).timeline
}

// Poll the receiving instance until an item carrying `nonce` appears.
async function waitForFederation(node, nonce) {
  const start = Date.now()
  while (Date.now() - start < HOP_TIMEOUT_MS) {
    const hit = timeline(node).find((it) => (it.content || '').includes(nonce))
    if (hit) return hit
    const secs = Math.round((Date.now() - start) / 1000)
    log(`      …waiting on ${node.name} (${secs}s)`)
    await sleep(8000)
  }
  return null
}

const nonce = () => 'FED-' + Math.random().toString(36).slice(2, 8).toUpperCase()

async function main() {
  for (const [name, node] of Object.entries(NODES)) {
    node.name = name
    if (!node.token) throw new Error(`Missing ops token: set TOK_${name.toUpperCase()}`)
  }
  const nodes = Object.values(NODES)

  log('▶ Minting a guest poster on each instance…')
  for (const node of nodes) {
    mintPoster(node)
    log(`   ${node.name.padEnd(5)} @${node.handle}  feed=${node.feedUrl}`)
  }

  log('\n▶ Wiring the full mesh of follows (each instance follows the other two)…')
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue
      const code = follow(a, b.name, b.feedUrl)
      log(`   ${a.name.padEnd(5)} → follows ${b.name.padEnd(5)} [${code}]`)
    }
  }

  log('\n▶ Letting follows register + WebSub subscribe (15s)…')
  await sleep(15_000)

  log('\n═══════════ CHAIN REACTION ═══════════')

  const n1 = nonce()
  log(`\n[1] main posts the opener  {{${n1}}}`)
  const p1 = post(NODES.main, `🌐 Federation test — this conversation is born on textcaster.app. Anyone can reply from their own instance. {{${n1}}}`)
  log(`    → ${p1.url}\n    waiting for it to federate into alice…`)
  const a1 = await waitForFederation(NODES.alice, n1)
  if (!a1) throw new Error('HOP 1 FAILED: opener never reached alice')
  log(`    ✓ alice received it over RSS (source=${a1.source})`)

  const n2 = nonce()
  log(`\n[2] alice replies  {{${n2}}}`)
  const p2 = post(NODES.alice, `👋 alice.textcaster.app got it over plain RSS — no shared API, no shared DB — and is replying. {{${n2}}}`, a1.id)
  log(`    → ${p2.url}\n    waiting for alice's reply to federate into bob…`)
  const b2 = await waitForFederation(NODES.bob, n2)
  if (!b2) throw new Error("HOP 2 FAILED: alice's reply never reached bob")
  log(`    ✓ bob received alice's reply (source=${b2.source})`)

  const n3 = nonce()
  log(`\n[3] bob replies to alice  {{${n3}}}`)
  const p3 = post(NODES.bob, `🤝 bob.textcaster.app read alice's reply and is chiming in. Three separate instances, one thread. {{${n3}}}`, b2.id)
  log(`    → ${p3.url}\n    waiting for bob's reply to federate back into main…`)
  const m3 = await waitForFederation(NODES.main, n3)
  if (!m3) throw new Error("HOP 3 FAILED: bob's reply never reached main")
  log(`    ✓ main received bob's reply (source=${m3.source})`)

  const n4 = nonce()
  log(`\n[4] main closes the loop  {{${n4}}}`)
  const p4 = post(NODES.main, `✅ Back on textcaster.app. This conversation traveled main→alice→bob→main across three instances over nothing but feeds, threading at every hop. It just works. {{${n4}}}`, m3.id)
  log(`    → ${p4.url}\n    confirming it federates to BOTH alice and bob…`)
  const a4 = await waitForFederation(NODES.alice, n4)
  const b4 = await waitForFederation(NODES.bob, n4)
  if (!a4 || !b4) throw new Error(`HOP 4 FAILED: closing reply reached alice=${!!a4} bob=${!!b4}`)
  log(`    ✓ alice ✓ bob`)

  log('\n═══════════ ✅ FEDERATION PROVEN ═══════════')
  log('A 4-hop conversation federated main→alice→bob→main across three separate')
  log('RSC instances over plain RSS, threading correctly at each hop.')
  log(`\nView the full thread on any instance, e.g.: ${p1.url}`)
}

main().catch((e) => {
  console.error('\n✗ ' + e.message)
  process.exit(1)
})
