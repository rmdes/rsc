export * from './logical-routes/write.ts'
export * from './logical-routes/read.ts'
export * from './logical-routes/personal.ts'
export * from './logical-routes/admin.ts'
export * from './logical-routes/public.ts'
// MAX_API_KEYS_PER_USER lives in the internal shared.ts (used by personal.ts +
// admin.ts) but is part of this module's public surface — core/src/auth.ts's
// anon-key-create gate imports it from here. Re-export it explicitly (the
// `export *` lines above do not re-export shared.ts, which is internal).
export { MAX_API_KEYS_PER_USER } from './logical-routes/shared.ts'
