package main

import "testing"

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
