import { test, expect } from 'vitest'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'

test('source:markdown is captured verbatim into ParsedItem.contentMarkdown', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>t</title>
<item><guid>g1</guid><description>&lt;p&gt;html&lt;/p&gt;</description><source:markdown>**md** with [link](https://x.ex)</source:markdown></item>
<item><guid>g2</guid><description>plain</description></item>
</channel></rss>`
  const { items } = await parseFeedWithMeta(rss)
  expect(items[0].contentMarkdown).toBe('**md** with [link](https://x.ex)')
  expect(items[1].contentMarkdown).toBeNull()
})
