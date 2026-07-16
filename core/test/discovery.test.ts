import { test, expect } from 'vitest'
import { discoverFeed } from '../src/domain/discovery.ts'

test('autodiscovery: returns the first alternate feed link, absolute, excluding bare json', () => {
  // microformats-parser rejects a <body> with no element children ("unable to
  // parse HTML"), so the body carries a harmless element — irrelevant to what
  // this test checks (head link parsing/ordering/resolution).
  const html = `<html><head>
    <link rel="alternate" type="application/json" href="/api.json">
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://other.example/atom">
  </head><body><p>hi</p></body></html>`
  const { feedUrl } = discoverFeed(html, 'https://site.example/blog')
  expect(feedUrl).toBe('https://site.example/feed.xml') // relative resolved, json skipped, first feed-typed wins
})

test('autodiscovery: none present → null', () => {
  // Same body-must-have-an-element constraint as above.
  const { feedUrl, hentries } = discoverFeed('<html><head></head><body><p>plain</p></body></html>', 'https://site.example/')
  expect(feedUrl).toBeNull()
  expect(hentries).toEqual([])
})

test('h-feed: a titled article keeps its title; an untitled note has title null (implied-name dropped)', () => {
  const html = `<div class="h-feed">
    <article class="h-entry"><h1 class="p-name">Real Title</h1><div class="e-content">Article body.</div><time class="dt-published" datetime="2026-01-01T10:00:00Z"></time><a class="u-url" href="https://s.ex/a">l</a></article>
    <div class="h-entry"><p class="e-content">Just a note, no title.</p><time class="dt-published" datetime="2026-01-02T10:00:00Z"></time><a class="u-url" href="https://s.ex/n">l</a></div>
  </div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/page')
  expect(hentries).toHaveLength(2)
  const article = hentries.find((h) => h.url === 'https://s.ex/a')!
  const note = hentries.find((h) => h.url === 'https://s.ex/n')!
  expect(article.title).toBe('Real Title')
  expect(article.content).toContain('Article body')
  expect(note.title).toBeNull()
  expect(note.content).toContain('Just a note')
  expect(note.guid).toBe('https://s.ex/n') // guid from u-url
})

test('h-feed: an undated note gets a deterministic guid across two parses (raw-date discipline)', () => {
  const html = `<div class="h-entry"><p class="e-content">dateless and linkless note</p></div>`
  const a = discoverFeed(html, 'https://s.ex/p').hentries[0]
  const b = discoverFeed(html, 'https://s.ex/p').hentries[0]
  expect(a.guid).toBe(b.guid) // fallbackGuid hashes raw fields, not "now"
})

test('h-feed: multiple bare h-entries with NO h-feed wrapper are all mapped (P1)', () => {
  const html = `<div class="h-entry"><p class="e-content">note one</p><a class="u-url" href="https://s.ex/1">l</a></div>
    <div class="h-entry"><p class="e-content">note two</p><a class="u-url" href="https://s.ex/2">l</a></div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/')
  expect(hentries.map((h) => h.url).sort()).toEqual(['https://s.ex/1', 'https://s.ex/2'])
})

test('degenerate HTML (childless body) → nulls, never throws (spec §7)', () => {
  const { feedUrl, hentries } = discoverFeed('<html><head></head><body></body></html>', 'https://s.ex/')
  expect(feedUrl).toBeNull()
  expect(hentries).toEqual([])
})
