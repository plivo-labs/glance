package main

import (
	"strings"
	"testing"
)

func TestDeleteCommand(t *testing.T) {
	t.Run("confirm-y-sends-delete", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, out := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n")
		if err := c.del([]string{"docs/api"}); err != nil {
			t.Fatalf("del: %v", err)
		}
		if len(*reqs) != 1 || (*reqs)[0].method != "DELETE" || (*reqs)[0].path != "/api/sites/docs/api" {
			t.Fatalf("request = %+v", *reqs)
		}
		if !strings.Contains(out.String(), "Deleted") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("confirm-n-cancels-no-request", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, out := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("\n") // empty = No
		if err := c.del([]string{"docs/api"}); err != nil {
			t.Fatalf("del: %v", err)
		}
		if len(*reqs) != 0 {
			t.Fatalf("expected no request, got %+v", *reqs)
		}
		if !strings.Contains(out.String(), "Cancelled") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("missing-slash-usage-error", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "tok")
		if err := c.del([]string{"nope"}); err == nil {
			t.Fatal("want usage error")
		}
	})

	// Extra path segments must be rejected, not silently truncated to space/slug (a/b/c -> a/b).
	t.Run("extra-segments-rejected", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, _ := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n")
		if err := c.del([]string{"space/slug/extra"}); err == nil {
			t.Fatal("want usage error for extra segments")
		}
		if len(*reqs) != 0 {
			t.Fatalf("must not send a request for a malformed target, got %+v", *reqs)
		}
	})
}

func TestMoveCommand(t *testing.T) {
	t.Run("posts-move-with-dest-body", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, `{"url":"https://g/team/api"}`
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.move([]string{"docs/api", "team"}); err != nil {
			t.Fatalf("move: %v", err)
		}
		r := (*reqs)[0]
		if r.method != "POST" || r.path != "/api/sites/docs/api/move" {
			t.Fatalf("request = %+v", r)
		}
		if !strings.Contains(r.ct, "application/json") || !strings.Contains(string(r.body), `"space":"team"`) {
			t.Fatalf("body/ct = %q %q", r.ct, r.body)
		}
		if !strings.Contains(out.String(), "https://g/team/api") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("missing-dest-usage-error", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "tok")
		if err := c.move([]string{"docs/api"}); err == nil {
			t.Fatal("want usage error")
		}
	})

	// A/b/c must not be truncated to a/b: reject the malformed source before hitting the network.
	t.Run("extra-segments-rejected", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.move([]string{"docs/api/extra", "team"}); err == nil {
			t.Fatal("want usage error for extra segments")
		}
		if len(*reqs) != 0 {
			t.Fatalf("must not send a request for a malformed target, got %+v", *reqs)
		}
	})
}
