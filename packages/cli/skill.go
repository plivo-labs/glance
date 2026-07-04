package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
)

// SKILL.md is a committed copy of the canonical glance-cli/SKILL.md, embedded so `skill install`
// ships it INSIDE the binary (the binary audience usually has neither Node nor npx). Keep it in
// sync via `go generate` (see below); TestSkillEmbedInSync guards the "forgot to re-copy" seam.
//
//go:generate sh -c "cp ../../glance-cli/SKILL.md SKILL.md"
//go:embed SKILL.md
var skillMD string

const skillName = "glance-cli"

// Install the bundled AI-agent skill with NO Node/npx dependency - writes it into Claude Code's
// user skills dir.
func (c *client) skillCmd(argv []string) error {
	sub := "install"
	if len(argv) > 0 {
		sub = argv[0]
	}
	if sub != "install" {
		return fmt.Errorf("Usage: glance skill install")
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".claude", "skills", skillName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dest := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(dest, []byte(skillMD), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "✓ Installed the %s skill for Claude Code → %s\n", skillName, dest)
	fmt.Fprintln(c.out, "  Other agents (Codex, Cursor): npx skills add plivo-labs/glance --global")
	return nil
}
