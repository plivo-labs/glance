package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestNotificationsCommand(t *testing.T) {
	fixtureBody := `{
  "items": [
    {
      "id": "n1",
      "type": "mention",
      "actorId": "u1",
      "actorName": "Ada",
      "siteLabel": "docs",
      "filePath": "index.md",
      "threadId": "t1",
      "commentId": "c1",
      "snippet": "hello there",
      "read": false,
      "readAt": null,
      "createdAt": "2026-07-16T12:00:00Z"
    },
    {
      "id": "n2",
      "type": "comment",
      "actorId": "u2",
      "actorName": null,
      "siteLabel": null,
      "filePath": null,
      "threadId": "t2",
      "commentId": null,
      "snippet": null,
      "read": true,
      "readAt": "2026-07-16T13:00:00Z",
      "createdAt": "2026-07-16T11:00:00Z"
    }
  ],
  "unreadCount": 1
}`

	t.Run("G-1", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, fixtureBody
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.notifications(nil); err != nil {
			t.Fatalf("notifications: %v", err)
		}
		got := out.String()
		if !strings.Contains(got, "1 unread · 2 shown") {
			t.Fatalf("want '1 unread · 2 shown' in %q", got)
		}
		if !strings.Contains(got, "●") {
			t.Fatalf("want unread marker ● in %q", got)
		}
		if !strings.Contains(got, "✓") {
			t.Fatalf("want read marker ✓ in %q", got)
		}
		if !strings.Contains(got, "mentioned you on") {
			t.Fatalf("want mention verb in %q", got)
		}
		if !strings.Contains(got, "commented on") {
			t.Fatalf("want comment verb in %q", got)
		}
		if !strings.Contains(got, "Someone") {
			t.Fatalf("want null actorName → Someone in %q", got)
		}
		if !strings.Contains(got, "a site") {
			t.Fatalf("want null siteLabel → a site in %q", got)
		}
	})

	t.Run("G-6", func(t *testing.T) {
		items := make([]string, 30)
		for i := range items {
			items[i] = fmt.Sprintf(`{"id":"n%d","type":"comment","actorId":"u","actorName":"A","siteLabel":"s","filePath":null,"threadId":"t","commentId":null,"snippet":null,"read":false,"readAt":null,"createdAt":"2026-07-16T12:00:00Z"}`, i)
		}
		body := `{"items":[` + strings.Join(items, ",") + `],"unreadCount":31}`
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, body
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.notifications(nil); err != nil {
			t.Fatalf("notifications: %v", err)
		}
		got := out.String()
		if !strings.Contains(got, "31 unread · 30 shown") {
			t.Fatalf("want header with true unreadCount, got %q", got)
		}
		if n := strings.Count(got, "●"); n != 30 {
			t.Fatalf("want 30 rendered items, got %d markers in %q", n, got)
		}
	})

	t.Run("G-2", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "")
		err := c.notifications(nil)
		if err == nil || !strings.Contains(err.Error(), "Not logged in") {
			t.Fatalf("want Not logged in, got %v", err)
		}
	})

	t.Run("G-3", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, `{}`
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.notifications([]string{"--read"}); err != nil {
			t.Fatalf("notifications --read: %v", err)
		}
		if len(*reqs) != 1 {
			t.Fatalf("want 1 request, got %d", len(*reqs))
		}
		r := (*reqs)[0]
		if r.method != "POST" {
			t.Fatalf("method = %q", r.method)
		}
		if r.path != "/api/notifications/read" {
			t.Fatalf("path = %q", r.path)
		}
		if string(r.body) != "{}" {
			t.Fatalf("body = %q, want {}", r.body)
		}
		if r.auth != "Bearer tok" {
			t.Fatalf("auth = %q", r.auth)
		}
		if r.ct != "application/json" {
			t.Fatalf("Content-Type = %q", r.ct)
		}
		if !strings.Contains(out.String(), "✓ Marked all notifications read") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("G-4", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, fixtureBody
		})
		c, out := newTestClient(srv.URL, "tok")
		if err := c.notifications([]string{"--json"}); err != nil {
			t.Fatalf("notifications --json: %v", err)
		}
		if out.String() != fixtureBody {
			t.Fatalf("want byte-equal body\ngot  %q\nwant %q", out.String(), fixtureBody)
		}
	})

	t.Run("G-5", func(t *testing.T) {
		t.Run("GET-500", func(t *testing.T) {
			srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
				return 500, `err`
			})
			c, _ := newTestClient(srv.URL, "tok")
			err := c.notifications(nil)
			if err == nil || !strings.Contains(err.Error(), "500") {
				t.Fatalf("want 500 in error, got %v", err)
			}
		})
		t.Run("POST-403", func(t *testing.T) {
			srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
				return 403, `forbidden`
			})
			c, _ := newTestClient(srv.URL, "tok")
			err := c.notifications([]string{"--read"})
			if err == nil || !strings.Contains(err.Error(), "403") {
				t.Fatalf("want 403 in error, got %v", err)
			}
		})
	})

	t.Run("read-json-rejected", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "tok")
		err := c.notifications([]string{"--read", "--json"})
		if err == nil || !strings.Contains(err.Error(), "--read and --json cannot be combined") {
			t.Fatalf("want combine error, got %v", err)
		}
	})
}

func TestTimeAgo(t *testing.T) {
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		createdAt string
		want      string
	}{
		{"just now", now.Add(-30 * time.Second).Format(time.RFC3339), "just now"},
		{"Xm", now.Add(-5 * time.Minute).Format(time.RFC3339), "5m ago"},
		{"Xh", now.Add(-3 * time.Hour).Format(time.RFC3339), "3h ago"},
		{"Xd", now.Add(-2 * 24 * time.Hour).Format(time.RFC3339), "2d ago"},
		{"unparseable", "not-a-time", "not-a-time"},
		{"future", now.Add(time.Hour).Format(time.RFC3339), "just now"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := timeAgo(tc.createdAt, now); got != tc.want {
				t.Fatalf("timeAgo(%q) = %q, want %q", tc.createdAt, got, tc.want)
			}
		})
	}
}
