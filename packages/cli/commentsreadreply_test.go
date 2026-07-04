package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCommentsCommand(t *testing.T) {
	threadsJSON := `[
		{"id":"t1","filePath":"index.md","quote":"hi","status":"open","comments":[{"author":"Ada","body":"reword","deleted":false}]},
		{"id":"t2","filePath":"index.md","quote":null,"status":"resolved","comments":[]}
	]`

	t.Run("digest-default-all-threads", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, threadsJSON })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.comments([]string{"docs/api"}); err != nil {
			t.Fatalf("comments: %v", err)
		}
		if (*reqs)[0].path != "/api/sites/docs/api/comments" {
			t.Fatalf("path = %q", (*reqs)[0].path)
		}
		if !strings.Contains(out.String(), "### index.md · OPEN · t1") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("file-filter-encodes-query", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `[]` })
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.comments([]string{"docs/api", "--file", "a b.md"}); err != nil {
			t.Fatalf("comments: %v", err)
		}
		if (*reqs)[0].path != "/api/sites/docs/api/comments?filePath=a%20b.md" {
			t.Fatalf("path = %q", (*reqs)[0].path)
		}
	})

	t.Run("open-and-json-flags", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) { return 200, threadsJSON })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.comments([]string{"docs/api", "--open", "--json"}); err != nil {
			t.Fatalf("comments: %v", err)
		}
		// --json + --open: raw array, filtered to open only (t2 resolved dropped)
		if !strings.Contains(out.String(), `"t1"`) || strings.Contains(out.String(), `"t2"`) {
			t.Fatalf("out = %q", out.String())
		}
	})
}

func TestReadCommand(t *testing.T) {
	t.Run("fetches-content-unauthed-raw", func(t *testing.T) {
		var contentAuth, contentPath string
		var srv *httptest.Server
		srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasPrefix(r.URL.Path, "/api/sites/docs/api"):
				// contentUrl always ends with '/'; points back at this same server
				fmt.Fprintf(w, `{"contentUrl":%q}`, srv.URL+"/content/")
			case strings.HasPrefix(r.URL.Path, "/content/"):
				contentAuth = r.Header.Get("Authorization")
				contentPath = r.URL.Path
				io.WriteString(w, "RAW<html>BYTES")
			default:
				w.WriteHeader(404)
			}
		}))
		defer srv.Close()

		c, out := newTestClient(srv.URL, "tok")
		if err := c.read([]string{"docs/api", "--file", "guide.html"}); err != nil {
			t.Fatalf("read: %v", err)
		}
		if out.String() != "RAW<html>BYTES" {
			t.Fatalf("out = %q (want raw, no trailing newline)", out.String())
		}
		if contentAuth != "" {
			t.Fatalf("content fetch must be unauthed (token rides in the path), got %q", contentAuth)
		}
		if contentPath != "/content/guide.html" {
			t.Fatalf("content path = %q", contentPath)
		}
	})
}

func TestReplyCommand(t *testing.T) {
	t.Run("positional-message-tagged", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.reply([]string{"docs/api", "t1", "done"}); err != nil {
			t.Fatalf("reply: %v", err)
		}
		r := (*reqs)[0]
		if r.method != "POST" || r.path != "/api/sites/docs/api/comments/t1/replies" {
			t.Fatalf("request = %+v", r)
		}
		if !strings.Contains(string(r.body), `"body":"[agent] done"`) {
			t.Fatalf("body = %q", r.body)
		}
		if !strings.Contains(out.String(), "Replied to t1") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("stdin-body-when-no-positional", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, _ := newTestClient(srv.URL, "tok")
		c.stdin = strings.NewReader("from pipe")
		c.stdinIsTTY = false
		if err := c.reply([]string{"docs/api", "t1"}); err != nil {
			t.Fatalf("reply: %v", err)
		}
		if !strings.Contains(string((*reqs)[0].body), `"body":"[agent] from pipe"`) {
			t.Fatalf("body = %q", (*reqs)[0].body)
		}
	})

	t.Run("tty-and-no-message-errors", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "tok")
		c.stdinIsTTY = true
		if err := c.reply([]string{"docs/api", "t1"}); err == nil {
			t.Fatal("want error: no body at a TTY")
		}
	})
}
