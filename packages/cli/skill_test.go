package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The embedded SKILL.md is a committed copy of the canonical glance-cli/SKILL.md (embedded so
// `glance skill install` ships it INSIDE the binary - no Node/npx). This pins the
// "edited the source but forgot to re-copy" seam, exactly like the TS skill-content.test.ts.
func TestSkillEmbedInSync(t *testing.T) {
	canonical, err := os.ReadFile(filepath.Join("..", "..", "glance-cli", "SKILL.md"))
	if err != nil {
		t.Fatalf("read canonical SKILL.md: %v", err)
	}
	if skillMD != string(canonical) {
		t.Error("embedded SKILL.md is stale — re-run `go generate ./...` (or the build:skill step) and commit SKILL.md")
	}
	if skillName != "glance-cli" {
		t.Errorf("skillName = %q", skillName)
	}
	if !strings.Contains(skillMD, "### reply") || !strings.Contains(skillMD, "glance reply <space/slug> <threadId>") {
		t.Error("embedded skill missing reply docs")
	}
}

func TestSkillInstall(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	c, out := newTestClient("http://unused", "")
	if err := c.skillCmd(nil); err != nil { // default subcommand is "install"
		t.Fatalf("skillCmd: %v", err)
	}
	dest := filepath.Join(os.Getenv("HOME"), ".claude", "skills", "glance-cli", "SKILL.md")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("skill not installed: %v", err)
	}
	if string(got) != skillMD {
		t.Error("installed SKILL.md != embedded content")
	}
	if !strings.Contains(out.String(), "Installed") {
		t.Fatalf("out = %q", out.String())
	}
}
