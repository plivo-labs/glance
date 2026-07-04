package main

import (
	"strings"
	"testing"
)

func TestListCommand(t *testing.T) {
	t.Run("renders-rows-and-sends-auth", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, `[
				{"siteSlug":"api-ref","spaceSlug":"docs","visibility":"team","url":"https://g/docs/api-ref"},
				{"siteSlug":"notes","spaceSlug":"me","visibility":"private","url":"https://g/me/notes"}
			]`
		})
		c, out := newTestClient(srv.URL, "tok123")
		if err := c.list(); err != nil {
			t.Fatalf("list: %v", err)
		}
		got := out.String()
		if !strings.Contains(got, "docs/api-ref") || !strings.Contains(got, "https://g/me/notes") {
			t.Fatalf("rows missing:\n%s", got)
		}
		if len(*reqs) != 1 || (*reqs)[0].path != "/api/sites/mine" || (*reqs)[0].method != "GET" {
			t.Fatalf("request = %+v", *reqs)
		}
		if (*reqs)[0].auth != "Bearer tok123" {
			t.Fatalf("auth header = %q", (*reqs)[0].auth)
		}
	})

	t.Run("empty-friendly", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `[]` })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.list(); err != nil {
			t.Fatalf("list: %v", err)
		}
		if strings.TrimSpace(out.String()) != "No sites yet." {
			t.Fatalf("got %q", out.String())
		}
	})

	t.Run("server-error-surfaces", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) { return 500, `boom` })
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.list(); err == nil {
			t.Fatal("want error on 500")
		}
	})
}
