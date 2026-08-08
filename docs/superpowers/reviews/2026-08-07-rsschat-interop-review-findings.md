# rss.chat interop milestone — review findings

Execution record for `docs/superpowers/plans/2026-08-07-rsschat-interop-compliance.md`
(spec rev 2). Merged to `main` at `3c457be`, 14 commits. Gates on the merged
result, run in-container per `TESTING.md`: core 1153/1153 (106 files),
typecheck 0; web 457/457 (49 files), svelte-check 0/0.

Eight review passes ran (one per task, plus a spec review, a plan review, and a
whole-branch review). This records what they found, because most of it was
**not** introduced by the milestone.

## The headline: four green tests encoded bugs

The core suite passed cleanly while the feeds failed an external validator. Three
existing tests asserted the defective behaviour as correct, and two assertions
could not fail:

| Test | What it pinned |
|---|---|
| `core/test/logical-outbound-threading.test.ts` | *"permalink wins over guid"* — the exact `parentReplyRef` defect below |
| `core/test/logical-feeds.test.ts` ("O4") | `isPermaLink="false"` on a **permalink-keyed** delivery — the `guidNotPermalink` defect, reached via direct DB seeding rather than acquisition, which is why a plan built from the acquisition path missed it |
| `core/test/feed.test.ts` (no-config) | `not.toContain`-only assertions — a 404 body would have satisfied them |
| `core/test/feed.test.ts` (ordering) | `indexOf(a) < indexOf(b)` — passes when `a` is absent |

Two more tests written *during* this milestone passed against deliberately-wrong
implementations before reviewers caught them. From Task 1 onward every task brief
was required to prove its test RED against a plausible wrong implementation;
findings fell to zero by Task 5.

## Pre-existing production bugs surfaced (not milestone scope)

1. **`parentReplyRef` returned the wrong identity.** It preferred the `permalink`
   identity key, but `projectRemote` emits a remote parent's **opaque delivery
   key** as that parent's `<guid>` (`acquisition.ts` delivery-key priority is
   opaque → permalink → fallback). Since `reconcile.ts` claims *both* keys for an
   ordinary RSS item, we emitted a reply ref that did not match the guid we
   advertise. Affected local replies too, via `local.ts`. Proven with a live probe.
2. **`projectLocal` emitted a frozen snapshot.** `local.ts` computes the reply ref
   at create time into `posts.in_reply_to`; `projectLocal` re-emitted that column
   verbatim while `projectRemote` re-derives live. So every local reply written
   before this branch still pointed at a string the parent's feed never
   advertised — the error the milestone existed to close, still live in production
   data, and invisible to the branch's own tests (which create replies after the
   fix). Fixed by re-deriving with the column as fallback: heals historical rows
   with no migration.
3. **`injectItemElements` matched inside CDATA.** It did a **document-wide**
   `indexOf` for `>guid</guid>`, and feedsmith emits `description`/`source:markdown`
   as raw CDATA — so a remote item whose body contained a guid-shaped literal
   naming another item **stole that item's `source:comments` ad**. Demonstrated
   live. Not XSS (CDATA cannot be escaped; fast-xml-parser splits `]]>`), but a
   public-feed misattribution any allowed remote source could trigger. Fixed by
   blanking CDATA spans in a length-preserving search copy and matching each
   `<item>`'s own guid.

## Design corrections made during execution

- `parentReplyRef` moved twice — `local.ts` → `roots.ts` (to break a
  `projector → local → threading → projector` cycle) → `projector.ts`, where it can
  mirror `projectRemote`'s guid derivation exactly rather than approximate it.
- The guid identity test began as `p.guid === p.url`, which compares a **raw** wire
  guid against a **normalized** permalink; a fragment-bearing guid was still
  downgraded. Now `(normalizePermalink(p.guid) ?? p.guid) === p.url`.
- `contentMarkdown` was found already stored by `convert.ts` for the whole
  v1-converted corpus, collapsing most of the planned heal into one projection line.
- `contentMarkdown` was the only captured string with **no size bound** — it is not
  in the canonical material, so it bypassed the 1 MiB evidence gate while being
  echoed verbatim into public feeds. Now bounded.

## Churn safety (the 2026-07-25 constraint)

`contentMarkdown` rides `normalized_json` and never enters `canonicalMaterialFor`.
Verified by probe, not by reading the test: the canonical material buffers compare
byte-equal with and without `source:markdown`, and a negative control confirms the
comparison is sensitive to a real content change. The heal sits only in the
byte-equal `unchanged` branch — no version row, no job re-pend, no journal effect,
idempotent by SQL guard (`json_extract(...) IS NULL` matches key-absent *and*
key-null).

## ⚠️ Validating only `/users/rss.xml` gives false PASSes

Found 2026-08-07, pre-deploy. The all-users feed is a **bounded moving window**
(`FEED_LIMIT`), so an offending item scrolls out as new posts arrive and the
validator simply stops seeing it. On that date `rsc.rmdes.be/users/rss.xml`
reported **0 errors** while the defect was fully intact — the same post still
produced `replyDoesntPointBack` on `/users/paul/feed.xml`, and its comments feed
still carried all four warnings.

**A green `/users/rss.xml` is therefore not evidence of anything.** Spec §6's
verification step names only that URL and would have reported success for a build
that changed nothing. Always validate all three kinds:

```bash
V() { curl -sS -m 150 -N "https://valid.rss.chat/validatestreaming?url=$(python3 -c \
  "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1")" \
  | python3 -c "import json,sys
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    try: d=json.loads(l)
    except: continue
    if 'result' in d:
        r=d['result']; print('%s e=%s w=%s' % ('$1', r['ctErrors'], r['ctWarnings']))
        [print('  [%s] %s @ %s' % (f['severity'], f['rule'], f.get('where','')[:70])) for f in r['findings']]"; }

V https://rsc.rmdes.be/users/rss.xml                                      # aggregate (windowed!)
V https://rsc.rmdes.be/users/paul/feed.xml                                # a user feed that HAS a reply
V https://rsc.rmdes.be/post/e0d403d4-a57d-4df7-bdd6-d1daed8a2a4f/comments.xml  # the known-bad comments feed
```

Pre-deploy baseline to compare against (2026-08-07, old code live):
aggregate 0e/2w · paul 1e/3w · comments 0e/5w.
After deploy, expect: paul's error gone; `selfMissing`, `guidNotPermalink`,
`itemsOutOfOrder` gone from the comments feed; `sourceNamespaceUnexpected` and the
reddit `urlAnsweredWithAnError` deliberately remaining; `markupWithoutMarkdown`
clearing on its own schedule (immediately for v1-converted items, on next poll for
post-cutover ones).

## Follow-ups — ALL CLOSED 2026-08-08

Worked in the order 5 → 4 → 3 → 2 → 1, auditing before each. Three of the five
audits corrected the finding as written, which is recorded below because the
corrections are the useful part.

**#5 — test assertions that cannot fail. `b9eaa1a`.**
Swept the suite for structurally-vacuous assertions. **The XSS drift canary was
vacuous on BOTH twins**: every assertion in "hostile fixtures never survive" was
negative, so all of them passed if the renderer returned `''` — mutation-proven by
stubbing `renderLocalHtml`. Both now bite. *The audit corrected the fix mid-flight:*
`renderLocalHtml('<script>…</script>ok')` legitimately returns `''` (remark drops a
raw-HTML block wholesale), so "benign text survives" is false for block-level
fixtures — the liveness proof uses ordinary markdown instead. Also documented that
**the twins are not behaviourally identical**: they share `SANITIZE_CONFIG`, not a
pipeline. Separately, three ops-token leak tests could pass on a 404; two now pin
measured status arrays, the third proves its reads returned data.

**#4 — comparator shape. `03ca414`.**
Tie-broke on id *descending* where `threading.ts:447 byOrder` does ascending, and
**never returned 0** (returned `-1` for equal ids — not a valid comparator).
Unreachable in practice; it simply read as house style without being it.

**#3 — opaque reply refs. `783f68c`.** *Audit widened this one.*
`reconcile.ts replyReference` treats a non-URL `inReplyTo` as a first-class
publisher-scoped OPAQUE key, and `replyWireElements` emits one with
`isPermaLink="false"` — so opaque refs are supported end to end, and the fallback
nulled them via `safeUrl`. That fires on **any unresolved ref**, not only the logged
tombstone case. `safeUrl` is a security gate, not a shape check, so the fix keeps
one: measured against Node's parser, `tag:`/`urn:` guids are kept, `javascript:`/
`data:`/`vbscript:`/`file:` rejected, and `//evil.com` rejected *despite not
parsing*, because it still linkifies. Both naive fixes fail.

**#2 — the identity-key fallback rung. `742fbc9`.** *Audit corrected itself twice.*
It first appeared to have a second trigger: `tombstones.ts` deletes only
`kind='delivery'` keys, so a purge looks like it leaves the opaque key to answer.
It does not — purging the last delivery leaves the parent with none, which converts
it to a structural tombstone, and `threading.ts:294` deletes **every** key. Two true
facts composing into a false third; only running it surfaced that. The rung has
exactly **one** reachable trigger: governance revoked. Now covered through the real
path (the parent 404s, proving the rung is what answers), mutation-checked.

**#1 — duplicated presentation derivation. `298923f`.**
Extracted `currentPresentation()`; `selectedDeliveryFor` now has one caller, so the
rule is expressed once and drift is unrepresentable rather than documented. The
first attempt dropped a binding `projectRemote` still needed — 77 failures, caught
by the gates before commit.

**Still open, unchanged:** the standing suggestion to keep auditing feed/threading
tests for assertions that encode assumptions rather than the protocol. #5 covered
the mechanical signatures (negative-only, absent-value ordering, zero-assertion);
it did not read every assertion for semantic correctness.
