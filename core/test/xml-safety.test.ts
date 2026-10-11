import { test, expect } from 'vitest'
import { renderFirehoseRss, renderCommentsFeed, renderRssFeed } from '../src/domain/feed.ts'
import type { LogicalItemDto } from '../src/logical/types.ts'
import { dto, remoteAuthor } from './dto-helper.ts'

const NOW = '2026-07-23T00:00:00.000Z'
const CTX = { publicUrl: 'https://cast.example.com', hubUrl: null, rssCloud: false }
// XML 1.0 Char production. Anything outside it makes a document not-well-formed:
//   Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
const ILLEGAL = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u
const A = (n: string) => remoteAuthor(n, 'https://o.example/f.xml')
const P = (over: Partial<LogicalItemDto>): LogicalItemDto => dto({
  id: 'p1', origin: 'remote', originGuid: 'g1', content: 'body',
  permalink: 'https://o.example/1', publishedAt: NOW, selectedAuthor: A('Author'), ...over,
})

test('no RSS render path can emit a character XML 1.0 forbids', () => {
  // Measured ingress (2026-08-08): our parser is lenient and accepts these off a
  // remote feed - raw NUL in RSS, raw U+FFFE, the &#xFFFE; char ref, and both via
  // JSON Feed. We therefore ingest what we cannot legally re-emit. One poisoned
  // remote item otherwise makes the whole containing feed unparseable for every
  // conformant reader, silently, because OUR parser is lenient enough not to notice.
  for (const code of [0x0000, 0x0001, 0x000B, 0x000C, 0x001F, 0xFFFE, 0xFFFF]) {
    const bad = 'a' + String.fromCharCode(code) + 'b'
    const hex = code.toString(16)
    for (const [label, xml] of [
      ['content', renderFirehoseRss([P({ content: bad })], CTX)],
      ['title', renderFirehoseRss([P({ title: bad })], CTX)],
      ['markdown', renderFirehoseRss([P({ contentMarkdown: bad })], CTX)],
      ['authorName', renderFirehoseRss([P({ selectedAuthor: A(bad) })], CTX)],
      ['guid', renderFirehoseRss([P({ originGuid: bad, permalink: null })], CTX)],
      // channel-level: the comments feed builds its <title> from the post body, so a
      // poisoned item breaks the CHANNEL element, not just its own <item>.
      ['commentsChannel', renderCommentsFeed(P({ content: bad }), [], CTX)],
      ['userFeed', renderRssFeed({ handle: '', displayName: 'A' }, [P({ content: bad })], CTX)],
    ] as const) {
      expect(xml).toContain('<rss') // rendered at all - not a vacuous pass
      expect([label, hex, ILLEGAL.test(xml)]).toEqual([label, hex, false])
    }
  }
})

test('xml-safety stripping does not damage legitimate content', () => {
  const rich = 'hello \u{1F680} <b>bold</b> tab\there & "quoted" ]]> 中文 é'
  const xml = renderFirehoseRss([P({ content: rich, title: rich, selectedAuthor: A(rich) })], CTX)
  expect(ILLEGAL.test(xml)).toBe(false)
  expect(xml).toContain('\u{1F680}') // astral plane survives (Char includes #x10000-#x10FFFF)
  expect(xml).toContain('中文')
  expect(xml).toContain('\t') // #x9 IS legal and must not be stripped
})
