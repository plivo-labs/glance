// The browser `glance.db` client (Quick-style DX) + a self-contained demo page, both served
// by the worker. This is the MVP client-delivery: the demo page runs on the TRUSTED app origin,
// mints a data token same-origin via /api/data-token (session cookie), then calls the bearer-
// authed /api/_data. Injecting this SDK into UNTRUSTED hosted pages requires the parent-frame
// credential broker (deliberately deferred — see the PR notes), so it is NOT wired into the
// content worker here. Kept as plain source strings (like install-script.ts) — no build step.

export const GLANCE_SDK_JS = `;(() => {
  let token = null
  async function ensureToken() {
    if (token) return token
    const boot = window.__GLANCE__ || {}
    if (boot.token) { token = boot.token; return token }
    const r = await fetch('/api/data-token/' + boot.space + '/' + boot.site, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    })
    if (!r.ok) throw new Error('glance: could not mint data token (' + r.status + ')')
    token = (await r.json()).token
    return token
  }
  async function call(method, path, body) {
    const t = await ensureToken()
    const res = await fetch('/api/_data' + path, {
      method,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204) return null
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || ('glance: ' + res.status))
    return data
  }
  function collection(name) {
    return {
      create: (data) => call('POST', '/' + name, data),
      get: (id) => call('GET', '/' + name + '/' + encodeURIComponent(id)),
      list: () => call('GET', '/' + name),
      put: (id, data) => call('PUT', '/' + name + '/' + encodeURIComponent(id), data),
      delete: (id) => call('DELETE', '/' + name + '/' + encodeURIComponent(id)),
    }
  }
  window.glance = { db: { collection } }
})()
`

export const GLANCE_DEMO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>glance.db demo</title>
<style>
  :root { color-scheme: light dark }
  body { max-width: 640px; margin: 3rem auto; padding: 0 1.25rem; font: 15px/1.6 -apple-system, system-ui, sans-serif }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem } p.sub { color: #6b7280; margin: 0 0 1.5rem }
  form { display: flex; gap: .5rem; margin-bottom: 1rem }
  input { flex: 1; padding: .55rem .7rem; border: 1px solid #d0d7de; border-radius: 8px; font: inherit }
  button { padding: .55rem 1rem; border: 0; border-radius: 8px; background: #0969da; color: #fff; font: inherit; cursor: pointer }
  ul { list-style: none; padding: 0; margin: 0; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden }
  li { padding: .6rem .9rem; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; gap: 1rem }
  li:first-child { border-top: 0 } .empty { color: #9ca3af; padding: .6rem .9rem }
  .meta { color: #9ca3af; font-size: .8em } code { font-family: ui-monospace, Menlo, monospace }
</style></head>
<body>
  <h1>glance.db — shared backend demo</h1>
  <p class="sub">Notes saved via <code>glance.db.collection('notes')</code> — no keys, no config.</p>
  <form id="f"><input id="t" placeholder="Write a note…" autocomplete="off" required><button>Save</button></form>
  <ul id="list"><li class="empty">loading…</li></ul>
  <script src="/api/glance.js"></script>
  <script>
    const q = new URLSearchParams(location.search)
    // space/site → mint same-origin via the session; or pass a pre-minted token= directly.
    window.__GLANCE__ = { space: q.get('space'), site: q.get('site'), token: q.get('token') || undefined }
    const notes = glance.db.collection('notes')
    const list = document.getElementById('list')
    async function render() {
      try {
        const { items } = await notes.list()
        list.innerHTML = items.length
          ? items.map((d) => {
              const li = document.createElement('li')
              const span = document.createElement('span'); span.textContent = d.data.text
              const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = new Date(d.createdAt).toLocaleTimeString()
              li.append(span, meta); return li.outerHTML
            }).join('')
          : '<li class="empty">no notes yet</li>'
      } catch (e) { list.innerHTML = '<li class="empty">' + e.message + '</li>' }
    }
    document.getElementById('f').addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const input = document.getElementById('t')
      await notes.create({ text: input.value }); input.value = ''; render()
    })
    render()
  </script>
</body></html>
`
