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
	dir := configDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// os.WriteFile's mode only applies on CREATE: install.sh seeds config.json at 0644 and login
	// truncate-rewrites it, so a plain WriteFile would leave the bearer token world-readable. Write
	// a fresh temp file (CreateTemp opens 0600) then rename(2) over the target - this both forces
	// 0600 and makes the swap atomic (no torn config on a crash mid-write).
	tmp, err := os.CreateTemp(dir, "config-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, configPath())
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
