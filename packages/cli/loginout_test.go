package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLoginCommand(t *testing.T) {
	t.Run("polls-then-persists-token", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		var polls int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/auth/cli/start":
				io.WriteString(w, `{"deviceCode":"DC","userCode":"WXYZ","verificationUri":"https://verify","interval":0}`)
			case "/api/auth/cli/poll":
				if r.URL.Query().Get("device_code") != "DC" {
					t.Errorf("poll device_code = %q", r.URL.Query().Get("device_code"))
				}
				if atomic.AddInt32(&polls, 1) < 2 {
					io.WriteString(w, `{"status":"pending"}`) // not ready yet
				} else {
					io.WriteString(w, `{"status":"complete","accessToken":"AT-123"}`)
				}
			default:
				w.WriteHeader(404)
			}
		}))
		defer srv.Close()

		c, out := newTestClient(srv.URL, "")
		if err := c.login(); err != nil {
			t.Fatalf("login: %v", err)
		}
		if !strings.Contains(out.String(), "WXYZ") || !strings.Contains(out.String(), "Logged in") {
			t.Fatalf("out = %q", out.String())
		}
		cfg := readConfig()
		if cfg == nil || cfg.Token != "AT-123" || cfg.ApiUrl != srv.URL {
			t.Fatalf("config = %+v", cfg)
		}
		if polls < 2 {
			t.Errorf("expected to poll until complete, polled %d", polls)
		}
	})

	t.Run("expired-request-errors", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/auth/cli/start":
				io.WriteString(w, `{"deviceCode":"DC","userCode":"UC","verificationUri":"https://v","interval":0}`)
			case "/api/auth/cli/poll":
				w.WriteHeader(404) // expired
			}
		}))
		defer srv.Close()
		c, _ := newTestClient(srv.URL, "")
		if err := c.login(); err == nil {
			t.Fatal("want error on expired login")
		}
	})
}

func TestLogoutCommand(t *testing.T) {
	t.Run("revoked-clears-and-confirms", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		_ = writeConfig(Config{ApiUrl: "https://x", Token: "tok"})
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{}` })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.logout(); err != nil {
			t.Fatalf("logout: %v", err)
		}
		if len(*reqs) != 1 || (*reqs)[0].method != "POST" || (*reqs)[0].path != "/api/auth/logout" {
			t.Fatalf("request = %+v", *reqs)
		}
		if (*reqs)[0].auth != "Bearer tok" {
			t.Fatalf("auth = %q", (*reqs)[0].auth)
		}
		if readConfig() != nil {
			t.Error("config file should be removed after logout")
		}
		if !strings.Contains(out.String(), "Logged out") {
			t.Fatalf("out = %q", out.String())
		}
	})

	// On a failed server-side revocation the local token still gets cleared, but we must NOT lie and
	// claim the session was revoked — a warning goes to stderr so the user knows the token may live on.
	t.Run("server-500-warns-but-still-clears-local", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		_ = writeConfig(Config{ApiUrl: "https://x", Token: "tok"})
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 500, `boom` })
		c, out := newTestClient(srv.URL, "tok")
		var warn strings.Builder
		c.errOut = &warn
		if err := c.logout(); err != nil {
			t.Fatalf("logout: %v", err)
		}
		if len(*reqs) != 1 {
			t.Fatalf("expected one revoke attempt, got %+v", *reqs)
		}
		if readConfig() != nil {
			t.Error("local token must be cleared even when revocation fails")
		}
		if !strings.Contains(warn.String(), "may remain valid") {
			t.Fatalf("want a revocation warning on 500, stderr = %q", warn.String())
		}
		if !strings.Contains(out.String(), "Logged out") {
			t.Fatalf("out = %q", out.String())
		}
	})
}
