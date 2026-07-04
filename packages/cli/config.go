package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	ApiUrl string `json:"apiUrl"`
	Token  string `json:"token,omitempty"`
}

func configDir() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".glance")
}

func configPath() string {
	return filepath.Join(configDir(), "config.json")
}

// readConfig returns nil on any error (missing/corrupt), mirroring the JS try/catch -> null.
func readConfig() *Config {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return nil
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil
	}
	return &c
}

func writeConfig(cfg Config) error {
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), data, 0o600)
}

// Instance URL precedence: explicit env override -> persisted config -> local dev default. Uses
// the `|| not ??` semantics: a blank/whitespace GLANCE_API_URL falls through instead of yielding
// a bad base URL.
func apiBase() string {
	if v := strings.TrimSpace(os.Getenv("GLANCE_API_URL")); v != "" {
		return v
	}
	if c := readConfig(); c != nil && c.ApiUrl != "" {
		return c.ApiUrl
	}
	return "http://localhost:8787"
}
