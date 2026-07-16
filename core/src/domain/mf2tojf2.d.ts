declare module '@paulrobertlloyd/mf2tojf2' {
  export interface Jf2 {
    type?: string
    name?: string
    summary?: string
    content?: string | { html?: string; text?: string }
    published?: string
    url?: string
    uid?: string
    children?: Jf2[]
  }
  export function mf2tojf2(parsed: unknown): Jf2
}
