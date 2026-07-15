import { test, expect, vi } from 'vitest'
import { choosePushTarget } from '../src/domain/push-in.ts'

const FEED = 'https://blog.example.com/feed.xml'

test('choosePushTarget prefers websub, topic = advertised self else feedUrl', () => {
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/rss', cloud: null }, FEED))
    .toEqual({ mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/rss' })
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: null, cloud: null }, FEED))
    .toEqual({ mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: FEED })
})

test('choosePushTarget falls back to an http-post cloud, and yields null otherwise', () => {
  const cloud = { domain: 'blog.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' }
  expect(choosePushTarget({ hubs: [], self: null, cloud }, FEED))
    .toEqual({ mode: 'rsscloud', endpoint: 'http://blog.example.com:5337/rsscloud/pleaseNotify', topic: FEED })
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: null, cloud }, FEED)?.mode).toBe('websub') // websub preferred
  expect(choosePushTarget({ hubs: [], self: null, cloud: { ...cloud, protocol: 'xml-rpc' } }, FEED)).toBeNull()
  expect(choosePushTarget({ hubs: [], self: null, cloud: null }, FEED)).toBeNull()
})
