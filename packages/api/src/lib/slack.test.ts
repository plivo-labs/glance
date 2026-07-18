import { describe, expect, test } from 'bun:test'
import { countingKv } from '../test/harness'
import { deliverSlack, formatSlackMessage, lookupSlackId } from './slack'

// Records every fetch call so specs can assert exact request count, URL, and headers.
function recordingFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const bearer = (init?: RequestInit) => new Headers(init?.headers).get('Authorization')

describe('lookupSlackId', () => {
  test('S2: cache miss → one lookup with email + Bearer, returns user.id, caches 30d', async () => {
    const kv = countingKv()
    const { fetchImpl, calls } = recordingFetch(() => Response.json({ ok: true, user: { id: 'U123' } }))

    const id = await lookupSlackId({ kv, token: 'xoxb-tok', fetchImpl }, 'Sam@Plivo.com')

    expect(id).toBe('U123')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(encodeURIComponent('Sam@Plivo.com'))
    expect(bearer(calls[0].init)).toBe('Bearer xoxb-tok')
    expect(kv.store.get('slackuid:sam@plivo.com')).toBe('U123')
    expect(kv.ttls.get('slackuid:sam@plivo.com')).toBe(2_592_000)
  })

  test('S3: cache hit returns id without fetching; negative marker never returned as a channel', async () => {
    const kv = countingKv()
    await kv.put('slackuid:hit@plivo.com', 'Uhit')
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new Error('must not fetch on a cache hit')
    })
    kv.ops() // reset baseline not needed; count from here
    const hit = await lookupSlackId({ kv, token: 't', fetchImpl }, 'hit@plivo.com')
    expect(hit).toBe('Uhit')
    expect(calls).toHaveLength(0)

    await kv.put('slackuid:none@plivo.com', '-') // NEGATIVE marker
    const neg = await lookupSlackId({ kv, token: 't', fetchImpl }, 'none@plivo.com')
    expect(neg).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('S4a: users_not_found → null, negative marker cached 1h', async () => {
    const kv = countingKv()
    const { fetchImpl, calls } = recordingFetch(() => Response.json({ ok: false, error: 'users_not_found' }))
    const id = await lookupSlackId({ kv, token: 't', fetchImpl }, 'ghost@plivo.com')
    expect(id).toBeNull()
    expect(calls).toHaveLength(1)
    expect(kv.store.get('slackuid:ghost@plivo.com')).toBe('-')
    expect(kv.ttls.get('slackuid:ghost@plivo.com')).toBe(3_600)
  })

  test('S4b: transient (500 / network / invalid_auth / 429) → null, NO cache, re-attempts next call', async () => {
    for (const transient of [
      () => new Response('', { status: 500 }),
      () => {
        throw new Error('network down')
      },
      () => Response.json({ ok: false, error: 'invalid_auth' }),
      () => new Response('', { status: 429 }),
    ]) {
      const kv = countingKv()
      const { fetchImpl } = recordingFetch(transient)
      const id = await lookupSlackId({ kv, token: 't', fetchImpl }, 'x@plivo.com')
      expect(id).toBeNull()
      expect(kv.ops().put).toBe(0) // nothing poisoned
      expect(kv.store.has('slackuid:x@plivo.com')).toBe(false)

      // A follow-up call re-attempts the lookup (no cached marker to short-circuit it).
      const { fetchImpl: ok, calls } = recordingFetch(() => Response.json({ ok: true, user: { id: 'Ulate' } }))
      expect(await lookupSlackId({ kv, token: 't', fetchImpl: ok }, 'x@plivo.com')).toBe('Ulate')
      expect(calls).toHaveLength(1)
    }
  })

  test('S8: ok:true but missing user.id → null, no post, no positive cache', async () => {
    const kv = countingKv()
    const { fetchImpl } = recordingFetch(() => Response.json({ ok: true, user: {} }))
    const id = await lookupSlackId({ kv, token: 't', fetchImpl }, 'weird@plivo.com')
    expect(id).toBeNull()
    expect(kv.ops().put).toBe(0)
    expect(kv.store.has('slackuid:weird@plivo.com')).toBe(false)
  })
})

describe('formatSlackMessage', () => {
  const appUrl = 'https://glance.example.com'
  const base = {
    siteLabel: 'design/q3-dashboard',
    actorName: 'Ravi Anand',
    actorEmail: 'ravi@plivo.com',
    filePath: 'q3.html',
    threadId: 't1',
  } as const

  test('V1: owner verb + bold hyperlinked site; share omits "your site"', () => {
    const owner = formatSlackMessage({ ...base, reason: 'owner', snippet: 'hi' }, appUrl)
    expect(owner).toContain('commented on your site *<') // verb + bold link opener
    expect(owner).toContain('|design/q3-dashboard>*') // site label is the bold hyperlink text
    const share = formatSlackMessage({ ...base, reason: 'share', snippet: 'hi' }, appUrl)
    expect(share).toContain('commented on *<')
    expect(share).not.toContain('your site')
  })

  test('V2: participant verb + thread= in the site link; mention verb', () => {
    const p = formatSlackMessage({ ...base, reason: 'participant', snippet: 'hi' }, appUrl)
    expect(p).toContain('replied in a thread you commented on')
    expect(p).toContain('thread=t1') // rides the hyperlink URL
    const m = formatSlackMessage({ ...base, reason: 'mention', snippet: 'hi' }, appUrl)
    expect(m).toContain('mentioned you in a comment on')
  })

  test('S7: null actorName → bold email fallback; snippet is italic + escaped; empty/null snippet stays non-empty', () => {
    const withEmail = formatSlackMessage({ ...base, actorName: null, reason: 'share', snippet: 'a & b < c > d' }, appUrl)
    expect(withEmail).toContain('*ravi@plivo.com*') // bold actor from the email fallback
    expect(withEmail).toContain('> _a &amp; b &lt; c &gt; d_') // block-quoted, italic, escaped

    const empty = formatSlackMessage({ ...base, reason: 'share', snippet: '' }, appUrl)
    expect(empty.trim().length).toBeGreaterThan(0)
    expect(empty).toContain('commented on')
    expect(empty).not.toContain('\n>') // no quote line when the snippet is blank

    const nullSnippet = formatSlackMessage({ ...base, reason: 'share', snippet: null }, appUrl)
    expect(nullSnippet.trim().length).toBeGreaterThan(0)
  })

  test('actor is bold; the site label hyperlinks to the absolute deep link, with no trailing raw URL', () => {
    const msg = formatSlackMessage({ ...base, reason: 'mention', snippet: 'hey' }, appUrl)
    expect(msg).toContain('*Ravi Anand*')
    // the deep link rides the site label as a bold hyperlink (& entity-escaped per Slack)
    expect(msg).toContain(
      '*<https://glance.example.com/design/q3-dashboard/q3.html?thread=t1&amp;review=1|design/q3-dashboard>*',
    )
    expect(msg.split('\n')).toHaveLength(2) // verb line + quote; no separate URL line
  })
})

const EVENT = {
  actorName: 'Ravi Anand',
  actorEmail: 'ravi@plivo.com',
  siteLabel: 'design/q3-dashboard',
  filePath: 'q3.html',
  threadId: 't1',
  snippet: 'take a look',
} as const

// Parse the JSON body of a recorded chat.postMessage call.
const postBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as { channel: string; text: string }

describe('deliverSlack', () => {
  const appUrl = 'https://glance.example.com'

  test('S1: token absent/blank → resolves with zero KV and zero HTTP', async () => {
    for (const token of [undefined, '', '  ']) {
      const kv = countingKv()
      const { fetchImpl, calls } = recordingFetch(() => {
        throw new Error('must not fetch when token is absent')
      })
      await deliverSlack({ kv, token, fetchImpl, appUrl }, EVENT, [
        { id: 'u1', email: 'a@plivo.com', reason: 'owner' },
      ])
      expect(kv.ops()).toEqual({ get: 0, put: 0, delete: 0 })
      expect(calls).toHaveLength(0)
    }
  })

  test('core: one recipient → one post to its resolved channel with verb + snippet + link', async () => {
    const kv = countingKv()
    await kv.put('slackuid:owner@plivo.com', 'Uowner')
    const posts: Array<{ url: string; init?: RequestInit }> = []
    const { fetchImpl } = recordingFetch((url, init) => {
      posts.push({ url, init })
      return Response.json({ ok: true })
    })
    await deliverSlack({ kv, token: 'xoxb', fetchImpl, appUrl }, EVENT, [
      { id: 'u1', email: 'owner@plivo.com', reason: 'owner' },
    ])
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toContain('chat.postMessage')
    const body = postBody(posts[0].init)
    expect(body.channel).toBe('Uowner')
    expect(body.text).toContain('commented on your site *<')
    expect(body.text).toContain('|design/q3-dashboard>*')
    expect(body.text).toContain('> _take a look_')
    expect(body.text).toContain('thread=t1&amp;review=1')
  })

  test('cap 15, mention-first regardless of array order (10 mention + 10 comment, comment-first)', async () => {
    const kv = countingKv()
    const recipients = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, email: `c${i}@plivo.com`, reason: 'share' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, email: `m${i}@plivo.com`, reason: 'mention' as const })),
    ]
    for (const r of recipients) await kv.put(`slackuid:${r.email}`, `U-${r.id}`)
    const channels: string[] = []
    const { fetchImpl } = recordingFetch((_url, init) => {
      channels.push(postBody(init).channel)
      return Response.json({ ok: true })
    })
    await deliverSlack({ kv, token: 'xoxb', fetchImpl, appUrl }, EVENT, recipients)
    expect(channels).toHaveLength(15)
    // First 10 must be the mentions (priority), then 5 comments — never array order.
    expect(channels.slice(0, 10).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `U-m${i}`).sort())
    expect(channels.slice(10).every((c) => c.startsWith('U-c'))).toBe(true)
  })

  test('per-recipient isolation: one failing post never aborts the rest, never throws', async () => {
    const kv = countingKv()
    for (const e of ['a@plivo.com', 'b@plivo.com', 'c@plivo.com']) await kv.put(`slackuid:${e}`, `U-${e}`)
    let n = 0
    const sent: string[] = []
    const { fetchImpl } = recordingFetch((_url, init) => {
      n++
      if (n === 2) throw new Error('slack down')
      sent.push(postBody(init).channel)
      return Response.json({ ok: true })
    })
    await deliverSlack({ kv, token: 'xoxb', fetchImpl, appUrl }, EVENT, [
      { id: 'a', email: 'a@plivo.com', reason: 'owner' },
      { id: 'b', email: 'b@plivo.com', reason: 'owner' },
      { id: 'c', email: 'c@plivo.com', reason: 'owner' },
    ])
    expect(sent).toEqual(['U-a@plivo.com', 'U-c@plivo.com']) // b threw, a and c still delivered
  })

  test('recipients with no email are skipped (no lookup, no post)', async () => {
    const kv = countingKv()
    const { fetchImpl, calls } = recordingFetch(() => Response.json({ ok: true }))
    await deliverSlack({ kv, token: 'xoxb', fetchImpl, appUrl }, EVENT, [
      { id: 'noemail', email: null, reason: 'owner' },
    ])
    expect(calls).toHaveLength(0)
    expect(kv.ops().get).toBe(0)
  })

  test('a KV cache-put failure after a live lookup still delivers the DM (best-effort cache)', async () => {
    const kv = countingKv()
    kv.failNextPut(new Error('kv down'))
    let posts = 0
    const { fetchImpl } = recordingFetch((url) => {
      if (url.includes('lookupByEmail')) return Response.json({ ok: true, user: { id: 'Ulive' } })
      posts++
      return Response.json({ ok: true })
    })
    await deliverSlack({ kv, token: 'xoxb', fetchImpl, appUrl }, EVENT, [
      { id: 'u1', email: 'live@plivo.com', reason: 'owner' },
    ])
    expect(posts).toBe(1)
  })
})
