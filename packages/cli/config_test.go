package main

import (
	"os"
	"strings"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := readConfig(); got != nil {
		t.Fatalf("readConfig on empty home = %+v, want nil", got)
	}
	if err := writeConfig(Config{ApiUrl: "https://x.example", Token: "tok"}); err != nil {
		t.Fatalf("writeConfig: %v", err)
	}
	got := readConfig()
	if got == nil || got.ApiUrl != "https://x.example" || got.Token != "tok" {
		t.Fatalf("roundtrip = %+v", got)
	}
}

// A token file must never be world-readable. install.sh seeds config.json at 0644 and login
// rewrites it in place, so writeConfig has to force 0600 on the resulting file (not just on create).
func TestConfigTokenFilePrivate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// Simulate install.sh seeding the config at 0644 before any login writes the token.
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath(), []byte(`{"apiUrl":"https://x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeConfig(Config{ApiUrl: "https://x", Token: "secret"}); err != nil {
		t.Fatalf("writeConfig: %v", err)
	}
	fi, err := os.Stat(configPath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config perm = %o, want 600 (token must not be world-readable)", perm)
	}
}

func TestApiBasePrecedence(t *testing.T) {
	t.Run("env-wins", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_API_URL", "https://env.example")
		_ = writeConfig(Config{ApiUrl: "https://cfg.example"})
		if got := apiBase(); got != "https://env.example" {
			t.Fatalf("apiBase = %q", got)
		}
	})

	t.Run("blank-env-falls-through-to-config", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_API_URL", "   ") // blank -> falls through (|| not ??)
		_ = writeConfig(Config{ApiUrl: "https://cfg.example"})
		if got := apiBase(); got != "https://cfg.example" {
			t.Fatalf("apiBase = %q", got)
		}
	})

	t.Run("default-when-nothing-set", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_API_URL", "")
		if got := apiBase(); got != "http://localhost:8787" {
			t.Fatalf("apiBase = %q", got)
		}
	})
}

func TestApiTokenPrecedence(t *testing.T) {
	t.Run("env-wins", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "env-tok")
		_ = writeConfig(Config{ApiUrl: "https://cfg.example", Token: "cfg-tok"})
		if got := apiToken(); got != "env-tok" {
			t.Fatalf("apiToken = %q", got)
		}
	})

	t.Run("blank-env-falls-through-to-config", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "   ") // blank -> falls through (|| not ??)
		_ = writeConfig(Config{ApiUrl: "https://cfg.example", Token: "cfg-tok"})
		if got := apiToken(); got != "cfg-tok" {
			t.Fatalf("apiToken = %q", got)
		}
	})

	t.Run("env-alone-with-no-config", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "env-tok")
		if got := apiToken(); got != "env-tok" {
			t.Fatalf("apiToken = %q", got)
		}
	})

	t.Run("empty-when-nothing-set", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "")
		if got := apiToken(); got != "" {
			t.Fatalf("apiToken = %q", got)
		}
	})
}

// dispatch() wiring. TestApiTokenPrecedence pins apiToken() in isolation, but nothing pinned that
// dispatch actually CALLS it — swapping both call sites for a literal "" left the whole suite
// green. These drive real commands through dispatch and assert the bearer that reaches the wire.
func TestDispatchTokenWiring(t *testing.T) {
	// An authed command must send GLANCE_TOKEN when it is set, so a CI job can deploy with an
	// API key it never wrote to disk. This is the whole point of the env override.
	t.Run("an authed command sends GLANCE_TOKEN over the stored token", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(*capturedReq) (int, string) { return 200, "[]" })
		t.Setenv("HOME", t.TempDir())
		if err := writeConfig(Config{ApiUrl: srv.URL, Token: "stored-session"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GLANCE_TOKEN", "glk_from-ci")

		if err := dispatch("list", nil); err != nil {
			t.Fatalf("dispatch(list): %v", err)
		}
		if len(*reqs) == 0 {
			t.Fatal("no request reached the server")
		}
		if got := (*reqs)[0].auth; got != "Bearer glk_from-ci" {
			t.Fatalf("authed command sent %q, want the env token", got)
		}
	})

	// logout is the exception, and it matters: it is a session verb. If GLANCE_TOKEN shadowed the
	// stored token here, logout would POST an API key, the server would 400 it (a key is revoked
	// from the keys screen), and the CLI would still delete config.json — the user's real session
	// token gone locally but still valid server-side.
	t.Run("logout sends the STORED token even when GLANCE_TOKEN is set", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(*capturedReq) (int, string) { return 200, `{"ok":true}` })
		t.Setenv("HOME", t.TempDir())
		if err := writeConfig(Config{ApiUrl: srv.URL, Token: "stored-session"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GLANCE_TOKEN", "glk_from-ci")

		if err := dispatch("logout", nil); err != nil {
			t.Fatalf("dispatch(logout): %v", err)
		}
		if len(*reqs) == 0 {
			t.Fatal("no request reached the server")
		}
		if got := (*reqs)[0].auth; got != "Bearer stored-session" {
			t.Fatalf("logout sent %q, want the stored session token", got)
		}
	})
}

// The env override has to be resolvable as a WHOLE credential. Before this, the token came from
// the env but the instance URL only from ~/.glance/config.json, so a CI container with both vars
// exported and no config file passed requireAuth() on the non-empty token and then failed every
// request with `unsupported protocol scheme ""`.
func TestDispatchEnvOnlyNeedsNoConfigFile(t *testing.T) {
	srv, reqs := recordingServer(t, func(*capturedReq) (int, string) { return 200, "[]" })
	t.Setenv("HOME", t.TempDir()) // no config.json at all
	t.Setenv("GLANCE_API_URL", srv.URL)
	t.Setenv("GLANCE_TOKEN", "glk_from-ci")

	if err := dispatch("list", nil); err != nil {
		t.Fatalf("dispatch(list) with env-only credentials: %v", err)
	}
	if len(*reqs) == 0 {
		t.Fatal("no request reached the server — the env-only path did not resolve a base URL")
	}
	if got := (*reqs)[0].auth; got != "Bearer glk_from-ci" {
		t.Fatalf("sent %q, want the env token", got)
	}
}

// ...and with neither set, the clean "Not logged in" message must survive: apiBase() falls back to
// the local dev URL, so it is the empty TOKEN that requireAuth() catches, not an empty URL.
func TestDispatchWithNoCredentialsStillSaysNotLoggedIn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GLANCE_API_URL", "")
	t.Setenv("GLANCE_TOKEN", "")

	err := dispatch("list", nil)
	if err == nil {
		t.Fatal("expected an error with no credentials")
	}
	if !strings.Contains(err.Error(), "Not logged in") {
		t.Fatalf("error = %q, want the clean \"Not logged in\" message", err)
	}
}
