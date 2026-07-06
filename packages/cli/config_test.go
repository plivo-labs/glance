package main

import (
	"os"
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
