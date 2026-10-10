# Split SqliteRepository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `SourceRepository` half of `SqliteRepository` (`core/src/storage/sqlite.ts`) into its own class, `SqliteSourceRepository` in `core/src/storage/source-sqlite.ts`, held by the repository as `readonly sources` over the same connection. No behaviour changes.

**Architecture:** Two green commits. Task 1 moves every consumer onto the final access path, `repo.sources`, while that getter still returns `this`, so behaviour is unchanged and there are no forwarding methods. Task 2 is the pure move. The code moves by **anchored extraction script**, not retyping, and a line-multiset diff proves it is byte-identical.

**Tech Stack:** Node native TypeScript type stripping (core, no build) · better-sqlite3 · vitest 5 · `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-10-split-sqlite-repository-design.md` (rev 3).

**Dry-run proven.** Every script and code block in this plan was applied, verbatim from this file, to a throwaway copy of the repo. The fully moved copy was then type-checked and tested **inside the core container**. The host's `node_modules` is stale, so a host typecheck fails even on unmodified code. Results: Task 1 state typecheck 0; Task 2 state typecheck 0, core **108 files / 1224 tests**, the Step 6 byte-identity diff clean, and no unused imports in either file. Each "Expected" value below is a measured result, not an estimate.

## Global Constraints

- **A pure move.** Moved method and helper bodies are byte-identical apart from leading whitespace. There is **one** named exemption: `this.splitPage(` → `splitPage(` at its four call sites. No query, schema, transaction-boundary or behaviour change.
- **Core `npm run typecheck` is the gate, not the test count.** Vitest runs under type stripping and does not type-check, so a call site that is wrong but has the right runtime shape can still pass tests. Typecheck must exit 0 after each task.
- `core/src` uses **no TypeScript parameter properties**: constructors assign fields plainly.
- `core/src/storage/source-sqlite.ts` must contain **no import from `sqlite.ts`**.
- No re-export shims. Importers of moved items are repointed to the new file.
- No delegating façade: `SqliteRepository` never gains methods that forward to the source class.
- No test is added or removed, and test edits are mechanical access-path changes. **Exactly one assertion changes:** `core/test/logical-tombstones.test.ts` pins `expect(on.repo).toBe(repo)`, meaning the plane hands back the object it was given. The design deliberately makes the plane return `repo.sources`, so the assertion becomes `toBe(repo.sources)`. That keeps its intent (the plane exposes the repository's real source store, not a copy) and passes in both tasks. Found by dry-running this plan: without the edit, Task 2 fails exactly that one test.
- Tests and typecheck run **in the dev container**: `docker compose exec -T core …`. Never run `npm install`/`npm ci` inside a container.
- **Shared checkout:** a parallel session commits on `main`. Never `git add -A` and never `git stash`. Stage explicit paths only.
- Every commit message ends with the line: `developed with the help of AI tools`
- **Baselines:** core 108 files / 1224 tests; web 56 files / 487 tests; core typecheck exit 0. They must be unchanged after each task.
- **Run every multi-line shell or Python block as ONE command.**

---

### Task 1: Every consumer reaches the source half through `repo.sources`

`SqliteRepository` gets `get sources(): SourceRepository { return this }`. The source service and all tests switch to that path. Everything stays green, because the getter returns the same object.

**Files:**
- Modify: `core/src/storage/sqlite.ts` (add the getter after `get raw()`)
- Modify: `core/src/domain/source-service.ts:76-96` (signatures) and its 8 source-method call sites
- Modify: 9 test files (69 direct source-method calls), 35 test files (38 sites that pass the repository as a `SourceRepository`), and `core/test/logical-tombstones.test.ts` (one identity assertion)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SqliteRepository.sources: SourceRepository`, a getter returning `this` in this task. Task 2 turns it into a field holding a `SqliteSourceRepository`; callers see no difference.
  - `type SourceStore = Pick<Repository, 'getSetting' | 'getUserByHandle'> & { sources: SourceRepository }`, exported from `core/src/domain/source-service.ts`. `createSourcePlane` and `createSourceService` take it as their `repo` parameter.

- [ ] **Step 1: Add the getter**

In `core/src/storage/sqlite.ts`, immediately after the existing `get raw()` getter (which ends `return this.sqlite\n  }`), insert:

```ts

  // The source-control plane's access path. Every consumer goes through it, so
  // the SourceRepository half can move to its own class without touching them.
  get sources(): SourceRepository {
    return this
  }
```

- [ ] **Step 2: Narrow the source service's dependency**

In `core/src/domain/source-service.ts`, directly after the import block (before `const OPERATION = 'subscribe'`), add:

```ts
// What the source plane actually needs from the repository: two reads, plus the
// source store itself. Narrower than `Repository & SourceRepository`, which made
// the two persistence concerns look like one.
export type SourceStore = Pick<Repository, 'getSetting' | 'getUserByHandle'> & { sources: SourceRepository }
```

Replace lines 76-82, `createSourcePlane`:

```ts
export function createSourcePlane(
  repo: Repository & SourceRepository,
  publicUrl: string | null,
  logicalStore: { isTombstoned(url: string): boolean } | undefined,
): { service: SourceService; repo: Repository & SourceRepository } {
  return { service: createSourceService(repo, publicUrl, undefined, logicalStore && ((url) => logicalStore.isTombstoned(url))), repo }
}
```

with:

```ts
export function createSourcePlane(
  repo: SourceStore,
  publicUrl: string | null,
  logicalStore: { isTombstoned(url: string): boolean } | undefined,
): { service: SourceService; repo: SourceRepository } {
  return { service: createSourceService(repo, publicUrl, undefined, logicalStore && ((url) => logicalStore.isTombstoned(url))), repo: repo.sources }
}
```

In the `createSourceService` signature (line 96), replace `repo: Repository & SourceRepository` with `repo: SourceStore`. Keep the parameter name `repo`.

- [ ] **Step 3: Route the eight source calls through `repo.sources`**

In `core/src/domain/source-service.ts`, prefix exactly these eight calls with `.sources`: `repo.followLocalAccount(` (line 108), `repo.resolveAndSubscribeSource(` (120), `repo.importSourceSubscriptions(` (167), `repo.ownerFollowing(` (180), `repo.publicFollowing(` (183), `repo.unsubscribe(` (192), `repo.establishFederation(` (214) and `repo.transition(` (234). Each `repo.X(` becomes `repo.sources.X(`.

Leave `repo.getUserByHandle(` (102, 146) and `repo.getSetting(` (118, 165) unchanged.

Run as ONE command:

```bash
cd /home/rmdes/textcaster
python3 - <<'EOF'
import re, pathlib
p = pathlib.Path('core/src/domain/source-service.ts')
s = p.read_text()
M = 'followLocalAccount|resolveAndSubscribeSource|importSourceSubscriptions|ownerFollowing|publicFollowing|unsubscribe|establishFederation|transition'
s2, n = re.subn(r'(?<![\w.])repo\.(' + M + r')\(', r'repo.sources.\1(', s)
p.write_text(s2)
print('replaced:', n)
EOF
grep -nE "repo\.(getUserByHandle|getSetting)\(" core/src/domain/source-service.ts
```

Expected: `replaced: 8`, and the four repository calls still read `repo.getUserByHandle(` / `repo.getSetting(`.

- [ ] **Step 4: Typecheck the production change**

Run: `docker compose exec -T core npm run typecheck -w core; echo "exit: $?"`
Expected: `exit: 0`. Every existing caller passes a `SqliteRepository`, which satisfies `SourceStore`.

- [ ] **Step 5: Rewrite the 69 direct source-method calls in tests**

The match is `repo.X(` or `deps.repo.X(` for the 17 source methods. It must not be preceded by any other `.`, so a value like `plane.repo.X(` (already a `SourceRepository`) is left alone. Run as ONE command:

```bash
cd /home/rmdes/textcaster
python3 - <<'EOF'
import re, pathlib
files = ['logical-v3-vertical','instance-member-reap','migration-convert','smoke','logical-policy-events',
         'source-cleanup','logical-fanout','source-cascade','source-reads']
M = ('getSource|listSourceSummaries|listApprovedFederationSources|getSourceDetail|listSourceSubscriptions|'
     'listSourceAudit|listSourceMembers|sourceMemberCounts|followLocalAccount|resolveAndSubscribeSource|'
     'importSourceSubscriptions|ownerFollowing|publicFollowing|unsubscribe|reapSource|establishFederation|transition')
pat = re.compile(r'(?<![\w.])((?:deps\.)?repo)\.(' + M + r')\(')
total = 0
for f in files:
    p = pathlib.Path(f'core/test/{f}.test.ts')
    s, n = pat.subn(r'\1.sources.\2(', p.read_text())
    p.write_text(s); total += n
    print(f'{f:24} {n}')
print('TOTAL', total)
EOF
```

Expected: `TOTAL 69`. If the total is lower, list each unmatched `repo.<sourceMethod>(` line in your report. Each must be on a value that is already a `SourceRepository`, not on the `SqliteRepository`.

- [ ] **Step 6: Rewrite the 38 sites that pass the repository as a `SourceRepository`, and the one identity assertion**

These are 36 shorthand sites, `sources: { …, repo }`, spread over 33 files. Run as ONE command:

```bash
cd /home/rmdes/textcaster
python3 - <<'EOF'
import re, pathlib
pat = re.compile(r'(sources:\s*\{[^}]*?)(?<![\w.])repo(\s*\})')
total, files = 0, 0
for p in sorted(pathlib.Path('core/test').rglob('*.ts')):
    s, n = pat.subn(r'\1repo: repo.sources\2', p.read_text())
    if n: p.write_text(s); total += n; files += 1
print('TOTAL', total, 'in', files, 'files')
EOF
```

Expected: `TOTAL 36 in 33 files`. This was measured by dry-running this exact script. An earlier grep reported 37 / 34 because it also matched `repo: deps.repo }`, which is the explicit site below.

Then make the two explicit edits by hand:
- `core/test/logical-v3-vertical.test.ts:176`: `repo: deps.repo` → `repo: deps.repo.sources`
- `core/test/api-key-cap.test.ts:53`: `sourceRepo: repo` → `sourceRepo: repo.sources`
- `core/test/logical-tombstones.test.ts`, in the test `createSourcePlane wires the tombstone guard…`: `expect(on.repo).toBe(repo)` → `expect(on.repo).toBe(repo.sources)`. This is the one assertion edit (see Global Constraints). It passes in this task, where `repo.sources` *is* `repo`, and it is what keeps Task 2 green.

- [ ] **Step 7: Prove nothing is left on the old path**

Run as ONE command:

```bash
cd /home/rmdes/textcaster
M='getSource|listSourceSummaries|listApprovedFederationSources|getSourceDetail|listSourceSubscriptions|listSourceAudit|listSourceMembers|sourceMemberCounts|followLocalAccount|resolveAndSubscribeSource|importSourceSubscriptions|ownerFollowing|publicFollowing|unsubscribe|reapSource|establishFederation|transition'
echo "direct calls still on the repository:"; grep -rnE "(^|[^.[:alnum:]_])(deps\.)?repo\.($M)\(" core/test core/src --include='*.ts' | grep -v "storage/sqlite.ts" || echo "  none"
echo "shorthand sites left:"; grep -rnE "sources:\s*\{[^}]*(^|[^.[:alnum:]_])repo\s*\}" core/test --include='*.ts' || echo "  none"
echo "explicit sites:"; grep -nE "sourceRepo: repo\b|repo: deps\.repo\b" core/test/api-key-cap.test.ts core/test/logical-v3-vertical.test.ts | grep -v "\.sources" || echo "  none"
```

Expected: `none` three times. Typecheck cannot catch these in this task: the repository still implements `SourceRepository`, so a leftover site still compiles. Task 2's typecheck is the backstop.

- [ ] **Step 8: Gates**

```bash
cd /home/rmdes/textcaster
docker compose exec -T core npm run typecheck -w core; echo "tsc exit: $?"
docker compose exec -T core npm test -w core 2>&1 | grep -E "Test Files|Tests "
```

Expected: `tsc exit: 0`; **108 files, 1224 tests passed**.

- [ ] **Step 9: Commit**

```bash
cd /home/rmdes/textcaster
git add core/src/storage/sqlite.ts core/src/domain/source-service.ts core/test
git status --short
git commit -F - <<'EOF'
refactor(core): reach the source half through repo.sources

SqliteRepository gains `get sources(): SourceRepository { return this }` and
every consumer moves onto that path: the source plane's two entry points
now take SourceStore — Pick<Repository,'getSetting'|'getUserByHandle'> &
{ sources: SourceRepository }, the two repository reads they really use —
and the tests' 69 direct source calls and 38 hand-wired SourceRepository
sites go through `.sources`. One assertion, in logical-tombstones, pinned
the plane returning the very object it was given; it now pins
`repo.sources`, which is what the plane returns.

The getter returns the same object, so behaviour is unchanged and no method
forwards to anything: this is the final access path pointing at the current
object, not a façade. The next commit moves the SourceRepository half behind
it.

developed with the help of AI tools
EOF
```

Before committing, confirm that `git status --short` shows only `core/src/storage/sqlite.ts`, `core/src/domain/source-service.ts` and files under `core/test/`. `git add core/test` stages only the tracked test files that changed. If anything else under `core/test` is untracked, stage explicit paths instead.

---

### Task 2: The pure move

**Files:**
- Modify: `core/src/domain/source-repository.ts` (add `splitPage` after `clampLimit`, at `:198-200`)
- Create: `core/src/storage/source-sqlite.ts`
- Modify: `core/src/storage/sqlite.ts` (remove the moved code, change `implements`, getter → field, new import block)
- Modify: `core/src/migration/convert.ts:5`, `core/src/logical/membership.ts:2` (repoint imports)

**Interfaces:**
- Consumes: `SqliteRepository.sources` / `SourceStore` from Task 1.
- Produces:
  - `export function splitPage<R extends { created_at: string; id: string }>(rows: R[], lim: number): { page: R[]; nextCursor: string | null }` in `core/src/domain/source-repository.ts`.
  - `export class SqliteSourceRepository implements SourceRepository` with constructor `(raw: Database.Database)`, in `core/src/storage/source-sqlite.ts`. The same file also exports `insertAudit` and `RemoteSourceV2Row`.
  - `SqliteRepository.sources` becomes `readonly sources: SqliteSourceRepository`.

- [ ] **Step 1: Hoist `splitPage` into `source-repository.ts`**

In `core/src/domain/source-repository.ts`, immediately after `clampLimit` (whose body ends `return Math.max(1, Math.min(100, Math.trunc(n)))\n}`), insert:

```ts

// Shared tail of every v2 cursor-paginated read: rows arrived limit+1 deep;
// split off the displayed page and, if the extra row is present, encode a
// nextCursor off the last displayed row's (created_at, id).
export function splitPage<R extends { created_at: string; id: string }>(rows: R[], lim: number): { page: R[]; nextCursor: string | null } {
  const page = rows.slice(0, lim)
  const last = page[page.length - 1]
  return { page, nextCursor: rows.length > lim && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null }
}
```

Then, in `core/src/storage/sqlite.ts`:
- delete the `private splitPage` method and its three-line comment, starting at `  // Shared tail of every v2 cursor-paginated read` and ending at that method's closing `  }`, plus the blank line after it;
- replace all four `this.splitPage(` with `splitPage(`;
- add `splitPage` to the existing value import on line 10, `import { encodeCursor, clampLimit, … } from '../domain/source-repository.ts'`.

Run: `docker compose exec -T core npm run typecheck -w core; echo "exit: $?"`. Expected: `exit: 0`.

- [ ] **Step 2: Snapshot the pre-move file**

The byte-identity proof in Step 6 compares against this snapshot. Run as ONE command, and keep the printed path for Step 6:

```bash
cd /home/rmdes/textcaster
SNAP=$(mktemp --suffix=.sqlite-premove.ts) && cp core/src/storage/sqlite.ts "$SNAP" && echo "SNAP=$SNAP"
```

- [ ] **Step 3: Extract the source half into `source-sqlite.ts`**

This script moves four anchored ranges out of `sqlite.ts`:
- module range A, the journal header through `cascadeInstanceAction`;
- module range B, the V2 row shapes through `insertAudit`;
- module range C, `activatePendingSubscriptions`;
- class range D, the admin-reads header through the end of `transition`.

It asserts every anchor is unique, writes the new file, and applies the two class edits. Run as ONE command:

```bash
cd /home/rmdes/textcaster
python3 - <<'EOF'
import pathlib, re
src = pathlib.Path('core/src/storage/sqlite.ts')
lines = src.read_text().split('\n')
def idx(pattern):
    hits = [i for i, l in enumerate(lines) if re.match(pattern, l)]
    assert len(hits) == 1, (pattern, hits)
    return hits[0]
# Each range is [start, end): end is the first line that STAYS.
ranges = {
  'A': (idx(r'// --- V2 logical journal integration'), idx(r'interface UsersTable ')),
  'B': (idx(r'// v2 source-control plane row shapes'), idx(r'// The permanent legacy-handle reservation guard')),
  'C': (idx(r'// Ordinary pending subscriptions become active only once'), idx(r'type JoinedRow ')),
  'D': (idx(r'  // --- v2 source-control plane administrative reads'), idx(r'  close\(\): void \{')),
}
take = {k: lines[a:b] for k, (a, b) in ranges.items()}
for k, (a, b) in ranges.items(): print(k, 'lines', a + 1, '-', b, f'({b - a} lines)')

header = '''import type Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import type { User, PushProtocol } from '../domain/types.ts'
import type { RemoteSource, SourceSubscription, SourceAuditEvent, Page, SourceSummary, SourceDetail, PushSummary, FederationStatus, OwnerSourceFollow, PublicLocalFollow, PublicSourceFollow, PublicFollowingEntry, OwnerFollowingView, CommandEnvelope, AttributionMode, AuditCategory, FederationRelationship, SourceTransitionResult, SourceSubscriptionState, SourceGovernance, SourceOperation } from '../domain/types.ts'
import type { SourceRepository, Cursor, SubscribeResult, ImportSourcesResult, UnsubscribeResult, EstablishFederationResult, SourceTransitionAction, SourceAxes, ReapCommandResult } from '../domain/source-repository.ts'
import { clampLimit, splitPage, checkCommand, storeCommand, reapSourceIfOrphaned, reapSource as reapSourceFn, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import { appendJournal } from '../logical/journal.ts'
import { scheduleFanout } from '../logical/fanout.ts'
import { memberRows, memberRowsPage, memberCounts, approvedInstanceFor, approvedInstancePrefixes, prefixUpperBound } from '../logical/membership.ts'

// The SourceRepository half of the SQLite persistence layer: remote sources,
// federation, following and transitions. Split out of SqliteRepository
// (storage/sqlite.ts), which holds an instance as `sources` over the SAME
// connection. It touches only the raw better-sqlite3 handle, never Kysely.
'''
cls_open = '''export class SqliteSourceRepository implements SourceRepository {
  private raw: Database.Database

  // Plain assignment instead of a parameter property: Node's native type
  // stripping can't erase parameter properties.
  constructor(raw: Database.Database) {
    this.raw = raw
  }
'''
out = header + '\n' + '\n'.join(take['A']) + '\n' + '\n'.join(take['B']) + '\n' + '\n'.join(take['C']) + '\n' + cls_open + '\n' + '\n'.join(take['D']).rstrip('\n') + '\n}\n'
pathlib.Path('core/src/storage/source-sqlite.ts').write_text(out)

# remove ranges from the bottom up so earlier indices stay valid
for k in sorted(ranges, key=lambda k: ranges[k][0], reverse=True):
    a, b = ranges[k]; del lines[a:b]
s = '\n'.join(lines)

def once(old, new):
    global s
    assert s.count(old) == 1, (old, s.count(old))
    s = s.replace(old, new)
once('export class SqliteRepository implements Repository, SourceRepository {',
     'export class SqliteRepository implements Repository {')
once('''  private sqlite: InstanceType<typeof Database>
''', '''  private sqlite: InstanceType<typeof Database>
  // The source-control plane, over the same connection.
  readonly sources: SqliteSourceRepository
''')
once('''    this.sqlite = sqlite
  }''', '''    this.sqlite = sqlite
    this.sources = new SqliteSourceRepository(sqlite)
  }''')
once('''
  // The source-control plane's access path. Every consumer goes through it, so
  // the SourceRepository half can move to its own class without touching them.
  get sources(): SourceRepository {
    return this
  }
''', '')
src.write_text(s)
print('wrote core/src/storage/source-sqlite.ts and updated sqlite.ts')
EOF
```

Expected: four range lines printed, then the `wrote …` line. If an `assert` fires, stop and report it; it means the file differs from what this plan was written against.

- [ ] **Step 4: Replace `sqlite.ts`'s import block**

Replace lines 1-17 of `core/src/storage/sqlite.ts`, the whole import block, with:

```ts
import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, Subscription, PushProtocol, FeedType, Page } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'
import { hideResolvedReplyContext } from '../domain/types.ts'
import type { Cursor } from '../domain/source-repository.ts'
import { clampLimit, splitPage, reapSourceIfOrphaned, DEAD_SOURCE_FAILURES } from '../domain/source-repository.ts'
import { LOGICAL_V2_SCHEMA, LOGICAL_V3_SCHEMA, LOGICAL_V4_SCHEMA, LOGICAL_PERF_INDEXES, LOGICAL_PERF_INDEXES_2, AGGREGATE_PUBLISHER_IDENTITY_FIX, assertHandleUnreserved } from '../logical/schema.ts'
import type { LogicalStore } from '../logical/store.ts'
import { healMembers } from '../logical/membership.ts'
import { findCurrentDeliveryVersion } from '../logical/acquisition.ts'
import { deleteObservationVersions } from '../logical/tombstones.ts'
import { SqliteSourceRepository } from './source-sqlite.ts'
```

These lists come from a usage scan done when the plan was written: each name was counted in the moved code and in the code that stays. Typecheck is the authority for *missing* names. Step 7's unused-import check is the authority for *extra* names. If either one disagrees with this block, adjust **imports only** and record the change in your report.

- [ ] **Step 5: Repoint the two external importers**

- `core/src/migration/convert.ts:5`: `import { insertAudit } from '../storage/sqlite.ts'` → `import { insertAudit } from '../storage/source-sqlite.ts'`
- `core/src/logical/membership.ts:2`: `import type { RemoteSourceV2Row } from '../storage/sqlite.ts'` → `import type { RemoteSourceV2Row } from '../storage/source-sqlite.ts'`

Then run: `docker compose exec -T core npm run typecheck -w core; echo "exit: $?"`. Expected: `exit: 0`.

`membership.ts` → `source-sqlite.ts` is type-only and erases, while `source-sqlite.ts` → `membership.ts` is a value import. So no runtime cycle is created.

- [ ] **Step 6: Prove the move is byte-identical**

This compares every non-blank line removed from the snapshot with every line added to the new file and to `source-repository.ts`, ignoring leading whitespace. Whatever differs must be exactly the named exemptions. Substitute the `SNAP` path from Step 2, and run as ONE command:

```bash
cd /home/rmdes/textcaster
SNAP=<path printed in Step 2>
python3 - "$SNAP" <<'EOF'
import sys, subprocess, collections, pathlib
snap = pathlib.Path(sys.argv[1]).read_text().split('\n')
now  = pathlib.Path('core/src/storage/sqlite.ts').read_text().split('\n')
new  = pathlib.Path('core/src/storage/source-sqlite.ts').read_text().split('\n')
norm = lambda ls: collections.Counter(l.strip() for l in ls if l.strip())
removed = norm(snap) - norm(now)            # lines that left sqlite.ts
added   = norm(new)                         # everything in the new file
print('=== left sqlite.ts but NOT found in source-sqlite.ts ===')
for l, c in (removed - added).items(): print(f'  x{c}  {l}')
print('=== in source-sqlite.ts but NOT moved from sqlite.ts ===')
for l, c in (added - removed).items(): print(f'  x{c}  {l}')
EOF
```

**Expected, and nothing else.**

In the first list:
- the old import lines;
- `export class SqliteRepository implements Repository, SourceRepository {` (that line changed);
- the old getter's lines (`get sources(): SourceRepository {`, `return this`, its two comment lines).

In the second list:
- the new file's import lines and header comment;
- the class skeleton: `export class SqliteSourceRepository …`, `private raw: Database.Database`, the constructor and its comment, `this.raw = raw`.

Lines such as a bare `}` or `return this` can appear in both lists as *count* mismatches. That's acceptable only when the count matches the skeleton/getter lines above.

**Any moved method or helper body line in either list is a failure.** Stop and report it.

- [ ] **Step 7: Structural checks**

Run as ONE command:

```bash
cd /home/rmdes/textcaster
echo "implements:"; grep -n "implements" core/src/storage/sqlite.ts core/src/storage/source-sqlite.ts
echo "imports from sqlite.ts inside source-sqlite.ts (expect none):"; grep -n "sqlite.ts'" core/src/storage/source-sqlite.ts || echo "  none"
echo "this.splitPage left anywhere (expect none):"; grep -rn "this\.splitPage" core/src || echo "  none"
python3 - <<'EOF'
import re, pathlib
for f in ['core/src/storage/sqlite.ts', 'core/src/storage/source-sqlite.ts']:
    text = pathlib.Path(f).read_text()
    imports = '\n'.join(l for l in text.split('\n') if l.startswith('import '))
    body = '\n'.join(l for l in text.split('\n') if not l.startswith('import '))
    names = set()
    for m in re.finditer(r'import (?:type )?\{([^}]*)\}', imports):
        for part in m.group(1).split(','):
            part = part.strip()
            if part: names.add(part.split(' as ')[-1].strip())
    for m in re.finditer(r'import (?:type )?([A-Za-z_]\w*) from', imports): names.add(m.group(1))
    unused = sorted(n for n in names if not re.search(r'\b' + re.escape(n) + r'\b', body))
    print(f'{f}: unused imports -> {unused or "none"}')
EOF
wc -l core/src/storage/sqlite.ts core/src/storage/source-sqlite.ts
```

Expected:
- `SqliteRepository implements Repository {` and `SqliteSourceRepository implements SourceRepository {`;
- `none` for both greps;
- `unused imports -> none` for both files;
- `sqlite.ts` 922 lines and `source-sqlite.ts` 895, as measured in the plan's dry run. Small differences are fine if another commit has touched `sqlite.ts` in the meantime.

If an import is unused, delete it from the block and re-run the check.

- [ ] **Step 8: Gates, including boot**

The dev container does not reliably hot-reload host edits under WSL2, so restart core explicitly before the boot check. Run as ONE command:

```bash
cd /home/rmdes/textcaster
docker compose exec -T core npm run typecheck -w core; echo "tsc exit: $?"
docker compose exec -T core npm test -w core 2>&1 | grep -E "Test Files|Tests "
docker compose exec -T web env -u CORE_API_URL npm test -w web 2>&1 | grep -E "Test Files|Tests "
docker compose restart core >/dev/null
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core 2>/dev/null)" = "healthy" ] && break; sleep 5; done
echo "core: $(docker inspect -f '{{.State.Health.Status}}' rsc-core)"
docker compose logs core --tail 30 | grep -E "rsc core listening|Error|Cannot find" | tail -3
```

Expected:
- `tsc exit: 0`;
- core **108 / 1224**;
- web **56 / 487**;
- `core: healthy`;
- `rsc core listening on :8787`, with no `Error` / `Cannot find`.

`docker compose restart core` restarts the shared dev stack's core. Say so in your report.

- [ ] **Step 9: Commit**

```bash
cd /home/rmdes/textcaster
git add core/src/domain/source-repository.ts core/src/storage/source-sqlite.ts core/src/storage/sqlite.ts core/src/migration/convert.ts core/src/logical/membership.ts
git status --short
git commit -F - <<'EOF'
refactor(core): move the SourceRepository half into SqliteSourceRepository

SqliteRepository no longer implements SourceRepository. Its 17 source
methods, 7 private helpers and the source-only module helpers (policy
journal, V2 row mappers, insertAudit, activatePendingSubscriptions) move to
storage/source-sqlite.ts as SqliteSourceRepository, which the repository
holds as `readonly sources` over the same connection. The new class needs
one field, `raw` — the source half never touched Kysely.

A pure move, proven by a line-multiset diff against the pre-move file: the
only non-structural difference is the one shared helper, splitPage, hoisted
to domain/source-repository.ts beside encodeCursor so both halves import it
(its four `this.splitPage(` calls become `splitPage(`). source-sqlite.ts
imports nothing from sqlite.ts, so no cycle is possible; convert.ts and
membership.ts are repointed to the new file with no re-export shim. Imports
that became dead are pruned. No consumer changed — they already reach the
source half through `repo.sources` (previous commit).

developed with the help of AI tools
EOF
```

Confirm that `git status --short` showed only those five paths as staged before the commit ran.

---

## After the plan

- **Docs:** none needed. No live doc describes `SqliteRepository`'s shape (`TESTING.md:98` mentions the class only as an example LSP message, which stays true).
- **Deploy:** not part of this plan. The change has no behaviour change and no new dependency. It ships whenever the next deploy happens.
