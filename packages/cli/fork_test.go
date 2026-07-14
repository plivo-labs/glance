package main

import (
	"strings"
	"testing"
)

func TestForkCommand(t *testing.T) {
	// No flags: the body carries NO space/slug, so the server applies its own defaults (personal
	// space, `<slug>-copy`). A client-side guess here would drift from the server's suffixing.
	t.Run("posts-fork-with-empty-body-by-default", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, `{"url":"https://g/me/api-copy","siteSlug":"api-copy"}`
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.fork([]string{"docs/api"}); err != nil {
			t.Fatalf("fork: %v", err)
		}
		if len(*reqs) != 1 {
			t.Fatalf("requests = %+v", *reqs)
		}
		r := (*reqs)[0]
		if r.method != "POST" || r.path != "/api/sites/docs/api/fork" {
			t.Fatalf("request = %+v", r)
		}
		if r.auth != "Bearer tok" || !strings.Contains(r.ct, "application/json") {
			t.Fatalf("auth/ct = %q %q", r.auth, r.ct)
		}
		if string(r.body) != `{}` {
			t.Fatalf("body = %q, want {}", r.body)
		}
		if !strings.Contains(out.String(), "https://g/me/api-copy") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("space-and-name-flags-go-into-body", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, `{"url":"https://g/team/api-v2"}`
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.fork([]string{"docs/api", "--space", "team", "--name", "api-v2"}); err != nil {
			t.Fatalf("fork: %v", err)
		}
		r := (*reqs)[0]
		if r.path != "/api/sites/docs/api/fork" {
			t.Fatalf("path = %q", r.path)
		}
		// --name is the NEW SITE SLUG (as in `deploy --name`), so it maps to the body's `slug` field.
		if !strings.Contains(string(r.body), `"space":"team"`) || !strings.Contains(string(r.body), `"slug":"api-v2"`) {
			t.Fatalf("body = %q", r.body)
		}
		if !strings.Contains(out.String(), "✓ Forked → https://g/team/api-v2") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("missing-target-usage-error", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "tok")
		if err := c.fork(nil); err == nil {
			t.Fatal("want usage error")
		}
	})

	// a/b/c must not be truncated to a/b: reject the malformed source before hitting the network.
	t.Run("extra-segments-rejected", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.fork([]string{"docs/api/extra"}); err == nil {
			t.Fatal("want usage error for extra segments")
		}
		if len(*reqs) != 0 {
			t.Fatalf("must not send a request for a malformed target, got %+v", *reqs)
		}
	})

	t.Run("invalid-name-rejected-before-request", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.fork([]string{"docs/api", "--name", "NOPE!"}); err == nil {
			t.Fatal("want error for an invalid slug")
		}
		if len(*reqs) != 0 {
			t.Fatalf("must not send a request for an invalid slug, got %+v", *reqs)
		}
	})

	// Usage errors beat "Not logged in" (house ordering: validate args, then requireAuth).
	t.Run("requires-auth", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "")
		err := c.fork([]string{"docs/api"})
		if err == nil || !strings.Contains(err.Error(), "Not logged in") {
			t.Fatalf("err = %v, want Not logged in", err)
		}
	})

	// A slug collision (409) must surface the server's message, not a silent success.
	t.Run("server-error-surfaces-status-and-body", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
			return 409, `{"error":"slug taken"}`
		})
		c, out := newTestClient(srv.URL, "tok")
		err := c.fork([]string{"docs/api"})
		if err == nil || !strings.Contains(err.Error(), "409") || !strings.Contains(err.Error(), "slug taken") {
			t.Fatalf("err = %v", err)
		}
		if strings.Contains(out.String(), "Forked") {
			t.Fatalf("must not report success, out = %q", out.String())
		}
	})
}
