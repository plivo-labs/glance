// The browser `glance.db` client (Quick-style DX), served by the worker at /api/glance.js.
// MVP client-delivery: pages on the TRUSTED app origin set window.__GLANCE_DB__ = {space, site},
// and the SDK mints a short-lived data token same-origin via /api/data-token (session cookie),
// then calls the bearer-authed /api/_data. Tokens are re-minted before expiry and once on a 401,
// so long-lived pages keep working across the 300s TTL. Injecting this SDK into UNTRUSTED hosted
// pages requires the parent-frame credential broker (deliberately deferred — see
// SHARED_BACKEND.md), so it is NOT wired into the content worker. The global is __GLANCE_DB__,
// not __GLANCE__ — the content worker already injects __GLANCE__ for the annotate overlay.

export const GLANCE_SDK_JS = `;(() => {
  let token = null
  let expiresAt = 0
  async function mint() {
    const boot = window.__GLANCE_DB__ || {}
    const r = await fetch('/api/data-token/' + boot.space + '/' + boot.site, { method: 'POST' })
    if (!r.ok) throw new Error('glance: could not mint data token (' + r.status + ')')
    const data = await r.json()
    token = data.token
    expiresAt = Date.now() + Math.max(0, (data.expiresIn - 30)) * 1000
    return token
  }
  async function call(method, path, body, retried) {
    const t = token && Date.now() < expiresAt ? token : await mint()
    const res = await fetch('/api/_data' + path, {
      method,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && !retried) { token = null; return call(method, path, body, true) }
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
