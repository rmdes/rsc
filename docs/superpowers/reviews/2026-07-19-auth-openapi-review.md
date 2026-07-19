# Ponytail over-engineering review — auth OpenAPI dev-only reference spec

Spec: `docs/superpowers/specs/2026-07-19-auth-openapi-design.md`
Scope: over-engineering only (correctness/security routed elsewhere).

## Findings

- L36-46 (§1 flag): keep-as-is. New `TEXTCASTER_AUTH_OPENAPI` env var reusing the exact `rssCloud`/`pushIn` on/off pattern (config.ts:55-61) is the right rung — the project gates features on explicit validated env flags, not `NODE_ENV`. Threading through config keeps the throw-on-bad-value validation. Two lines. Do not reuse NODE_ENV (would bypass validation and break the "explicit flag" convention).
- L48-56 (§2 registration): keep-as-is. `if (deps.authOpenApi) plugins.push(openAPI())` reuses the existing `/api/auth/*` mount and adds no route/migration. Minimal.
- L58-65 (§3 web denylist): keep-as-is. `params.path === 'reference' || params.path.startsWith('open-api/')` → 404 is plain string ops, ~2 lines, and is the requested second independent guard on a security boundary. Not redundant with the flag.
- L68-71 (§4 compose): keep-as-is. Env in dev compose only; nothing to cut.
- L81-84 (testing / core): simplify. Drop invoking `generateOpenAPISchema()` and asserting non-empty `paths` — that re-tests better-auth's library. Our code change is only the conditional append, so assert the wiring toggles: `auth.api.generateOpenAPISchema` defined with flag on, undefined with flag off. Two cheap truthy checks, no handler spin-up, no library-behavior assertion.
- L85-89 (testing / web 404): keep-as-is. This is the one security-critical test the spec itself names as the real guarantee. Keep exactly as specified.
- L90-91 (tsc/svelte-check): keep-as-is. Standard project practice (type-stripping means vitest passes on type errors).
- L73-77 (CLAUDE.md invariant) + docs: keep-as-is. Requested convention, not code.

## Verdict

Spec is already minimal. Flag + proxy denylist are both intended (user-requested defense-in-depth) and each is ~2 lines. One simplify: trim the core test from a library-behavior assertion to a flag-toggle assertion. Nothing to cut. Ship.

net: ~0 lines of production code to cut; core test slightly leaner.
