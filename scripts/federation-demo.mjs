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
//   4. settle, then VERIFY: exactly one copy per post per instance, every reply's
//      parent resolved, and the public feeds carrying cross-origin source:inReplyTo
//
// Step 4 is the part that makes this a test rather than a demo. Arrival is not
// correctness: a post can arrive twice (two subscription paths to the same
// content — an instance feed and a per-user feed — mint two author rows, and
// posts_author_guid_uq is per-author so it cannot catch it), and a duplicated
// post is UNRESOLVABLE as a parent, because findPostByRef returns undefined on
// ambiguity. Parent resolution happens once, at insert, with no retry — so
// whether a reply threads depends on ingest arrival order. Checking only that
// content showed up hides both faults.
//
// Ops tokens (needed for the POST /users follow calls — guests are 403'd there)
// come from env: TOK_MAIN, TOK_ALICE, TOK_BOB. On a Cloudron deploy each one is
// the contents of /app/data/config/ops_token inside that app's container.
//   TOK_MAIN=… TOK_ALICE=… TOK_BOB=… node scripts/federation-demo.mjs
//
// This is an integration test against LIVE instances — it is intentionally not
// in the vitest suite (which runs core in-process). Exit code 0 = federation
// proven AND clean; non-zero = a hop failed, or it federated with defects (the
// verdict block says which).

import { execFileSync } from 'node:child_process'

const NODES = {
  main: { loc: 'rsc.rmdes.be', origin: 'https://rsc.rmdes.be', token: process.env.TOK_MAIN },
  alice: { loc: 'alice.rmdes.be', origin: 'https://alice.rmdes.be', token: process.env.TOK_ALICE },
  bob: { loc: 'bob.rmdes.be', origin: 'https://bob.rmdes.be', token: process.env.TOK_BOB },
}
const CORE = 'http://127.0.0.1:8787'
const HOP_TIMEOUT_MS = 180_000
// A second copy can land well after the first sighting, so the uniqueness check
// has to run on a quiet network, not the instant a nonce first appears.
const SETTLE_MS = 30_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

// Defects are collected, not thrown: the chain runs to completion so one run
// shows every fault, then the verdict decides the exit code.
const problems = []
function fail(msg) {
  problems.push(msg)
  log(`    ✗ ${msg}`)
}

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

function copies(node, nonce) {
  return timeline(node).filter((it) => (it.content || '').includes(nonce))
}

// Poll the receiving instance until an item carrying `nonce` appears. Returns
// every match, not the first — the count is itself a finding.
async function waitForFederation(node, nonce) {
  const start = Date.now()
  while (Date.now() - start < HOP_TIMEOUT_MS) {
    const hits = copies(node, nonce)
    if (hits.length) return hits
    const secs = Math.round((Date.now() - start) / 1000)
    log(`      …waiting on ${node.name} (${secs}s)`)
    await sleep(8000)
  }
  return []
}

// The internal timeline can look right while the feed — the only thing another
// instance ever sees — is wrong. So assert on the PUBLIC feed, over real HTTPS,
// from outside the container: the reply must carry a source:inReplyTo naming the
// parent, and that parent must live on a different origin. Same-origin means the
// conversation never actually crossed an instance boundary.
async function checkWire(node, nonce, parentUrl) {
  let xml
  try {
    const res = await fetch(node.feedUrl, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return fail(`${node.name}: public feed ${node.feedUrl} returned HTTP ${res.status}`)
    xml = await res.text()
  } catch (e) {
    return fail(`${node.name}: could not fetch public feed ${node.feedUrl}: ${e.message}`)
  }
  const item = xml.split('<item>').find((chunk) => chunk.includes(nonce))
  if (!item) return fail(`${node.name}: ${nonce} is absent from its author's public feed`)
  const m = /<source:inReplyTo>([^<]+)</.exec(item)
  if (!m) return fail(`${node.name}: ${nonce} carries no <source:inReplyTo> on the wire`)
  const ref = m[1].trim()
  if (ref !== parentUrl) return fail(`${node.name}: ${nonce} source:inReplyTo is ${ref}, expected ${parentUrl}`)
  if (new URL(ref).origin === new URL(node.origin).origin) {
    return fail(`${node.name}: ${nonce} replies to a same-origin post — not federated`)
  }
  log(`    ✓ wire: ${nonce} → ${new URL(ref).host} (cross-origin)`)
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
  // 201 = a NEW remote-user row. If the instance is ALSO already subscribed to
  // that peer's instance feed, the same posts now arrive down two paths under
  // two author ids — the duplicate this script's step 4 exists to catch.
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue
      const code = follow(a, b.name, b.feedUrl)
      const note = code === '201' ? '  (new subscription)' : code === '409' ? '  (already followed)' : '  ← unexpected'
      log(`   ${a.name.padEnd(5)} → follows ${b.name.padEnd(5)} [${code}]${note}`)
    }
  }

  log('\n▶ Letting follows register + WebSub subscribe (15s)…')
  await sleep(15_000)

  log('\n═══════════ CHAIN REACTION ═══════════')

  const n1 = nonce()
  log(`\n[1] main posts the opener  {{${n1}}}`)
  const p1 = post(NODES.main, `🌐 Federation test — this conversation is born on rsc.rmdes.be. Anyone can reply from their own instance. {{${n1}}}`)
  log(`    → ${p1.url}\n    waiting for it to federate into alice…`)
  const a1 = await waitForFederation(NODES.alice, n1)
  if (!a1.length) throw new Error('HOP 1 FAILED: opener never reached alice')
  log(`    ✓ alice received it over RSS (source=${a1[0].source})`)

  const n2 = nonce()
  log(`\n[2] alice replies  {{${n2}}}`)
  const p2 = post(NODES.alice, `👋 alice.rmdes.be got it over plain RSS — no shared API, no shared DB — and is replying. {{${n2}}}`, a1[0].id)
  log(`    → ${p2.url}\n    waiting for alice's reply to federate into bob…`)
  const b2 = await waitForFederation(NODES.bob, n2)
  if (!b2.length) throw new Error("HOP 2 FAILED: alice's reply never reached bob")
  log(`    ✓ bob received alice's reply (source=${b2[0].source})`)

  const n3 = nonce()
  log(`\n[3] bob replies to alice  {{${n3}}}`)
  const p3 = post(NODES.bob, `🤝 bob.rmdes.be read alice's reply and is chiming in. Three separate instances, one thread. {{${n3}}}`, b2[0].id)
  log(`    → ${p3.url}\n    waiting for bob's reply to federate back into main…`)
  const m3 = await waitForFederation(NODES.main, n3)
  if (!m3.length) throw new Error("HOP 3 FAILED: bob's reply never reached main")
  log(`    ✓ main received bob's reply (source=${m3[0].source})`)

  const n4 = nonce()
  log(`\n[4] main closes the loop  {{${n4}}}`)
  const p4 = post(NODES.main, `✅ Back on rsc.rmdes.be. This conversation traveled main→alice→bob→main across three instances over nothing but feeds, threading at every hop. It just works. {{${n4}}}`, m3[0].id)
  log(`    → ${p4.url}\n    confirming it federates to BOTH alice and bob…`)
  const a4 = await waitForFederation(NODES.alice, n4)
  const b4 = await waitForFederation(NODES.bob, n4)
  if (!a4.length || !b4.length) throw new Error(`HOP 4 FAILED: closing reply reached alice=${!!a4.length} bob=${!!b4.length}`)
  log(`    ✓ alice ✓ bob`)

  log(`\n═══════════ VERIFICATION (settling ${SETTLE_MS / 1000}s) ═══════════`)
  await sleep(SETTLE_MS)

  // 1. Every post, on every instance that should hold it, exactly once. A second
  //    copy is what makes its post unresolvable as a future reply target.
  log('\n▶ Uniqueness — one row per post per instance')
  const expected = [
    [n1, 'opener', nodes],
    [n2, "alice's reply", nodes],
    [n3, "bob's reply", nodes],
    [n4, 'closing reply', nodes],
  ]
  for (const [n, label, where] of expected) {
    for (const node of where) {
      const c = copies(node, n)
      if (c.length === 1) log(`    ✓ ${node.name.padEnd(5)} ${label} ×1`)
      else if (c.length === 0) fail(`${node.name}: ${label} (${n}) is missing`)
      else fail(`${node.name}: ${label} (${n}) is duplicated ×${c.length} — findPostByRef will refuse it as a parent`)
    }
  }

  // 2. Replies must actually be threaded, not merely present. inReplyToPostId is
  //    the resolved local parent; null means the reply landed orphaned.
  log('\n▶ Threading — every reply resolved to its parent')
  for (const [n, label] of [[n2, "alice's reply"], [n3, "bob's reply"], [n4, 'closing reply']]) {
    for (const node of nodes) {
      const c = copies(node, n)
      if (c.length !== 1) continue // already reported above
      if (c[0].inReplyToPostId) log(`    ✓ ${node.name.padEnd(5)} ${label} → parent resolved`)
      else fail(`${node.name}: ${label} (${n}) has inReplyToPostId=null — orphaned, and it is never retried`)
    }
  }

  // 3. The wire itself, fetched publicly. This is the claim that distinguishes
  //    RSC from a single-instance app: the parent lives on another origin.
  log('\n▶ Wire format — cross-origin source:inReplyTo in the public feeds')
  await checkWire(NODES.alice, n2, p1.url)
  await checkWire(NODES.bob, n3, p2.url)
  await checkWire(NODES.main, n4, p3.url)

  if (problems.length) {
    log('\n═══════════ ⚠️  FEDERATED, WITH DEFECTS ═══════════')
    log('The conversation traveled all four hops, but verification found:')
    for (const p of problems) log(`  • ${p}`)
    log(`\nThread: ${p1.url}`)
    process.exit(1)
  }

  log('\n═══════════ ✅ FEDERATION PROVEN ═══════════')
  log('A 4-hop conversation federated main→alice→bob→main across three separate')
  log('RSC instances over plain RSS: one copy per post, every reply threaded, and')
  log('cross-origin source:inReplyTo verified in the public feeds.')
  log(`\nView the full thread on any instance, e.g.: ${p1.url}`)
}

main().catch((e) => {
  console.error('\n✗ ' + e.message)
  process.exit(1)
})
