export interface Config { dbPath: string; token: string; port: number; pollSeconds: number; corsOrigin: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.TEXTCASTER_TOKEN
  if (!token) throw new Error('TEXTCASTER_TOKEN is required')
  return {
    dbPath: env.TEXTCASTER_DB ?? './data/textcaster.db',
    token,
    port: Number(env.TEXTCASTER_PORT ?? '8787'),
    pollSeconds: Number(env.TEXTCASTER_POLL_SECONDS ?? '60'),
    corsOrigin: env.TEXTCASTER_CORS_ORIGIN ?? 'http://localhost:5173',
  }
}
