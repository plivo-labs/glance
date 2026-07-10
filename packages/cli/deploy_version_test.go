package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// Phase 4 / S14 — a deploy from a PULLED tree (has .glance/pull.json) is version-aware: it sends the
// pulled contentVersion as expectedVersion, targets the recorded site, round-trips dotfiles, and
// never re-uploads the .glance marker. And the owner-only gate widens to canReplace so an editor
// (owned:false but canReplace:true) can redeploy.

func writePulledDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "site")
	writeFile(t, filepath.Join(dir, "index.html"), "<p>edited</p>")
	writeFile(t, filepath.Join(dir, ".well-known", "keep"), "secret-but-owned")
	writeFile(t, filepath.Join(dir, ".glance", "pull.json"), `{"space":"acme","name":"doc","contentVersion":5}`)
	return dir
}

func TestDeployVersioned(t *testing.T) {
	t.Run("cli.deploy.sendsVersion", func(t *testing.T) {
		dir := writePulledDir(t)
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":true,"canReplace":true,"contentVersion":5}`
		c, _ := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n") // confirm the Replace? prompt
		if err := c.deploy([]string{dir}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		// Targets the site from pull.json (not the caller's personal space / the dir name).
		if st.uploadPath != "/api/upload/acme/doc" || st.uploadQuery != "replace=true" {
			t.Fatalf("upload target = %q?%q", st.uploadPath, st.uploadQuery)
		}
		if st.expectedVersion != "5" {
			t.Errorf("expectedVersion = %q, want 5", st.expectedVersion)
		}
		// Pulled tree round-trips dotfiles (auto --include-hidden) but never re-uploads the marker.
		if st.files[".well-known/keep"] != "secret-but-owned" {
			t.Errorf("dotfile not round-tripped: %v", st.files)
		}
		if _, leaked := st.files[".glance/pull.json"]; leaked {
			t.Errorf(".glance/ marker must be excluded from the upload")
		}
	})

	t.Run("cli.deploy.editor.canReplace", func(t *testing.T) {
		dir := writePulledDir(t)
		srv, st := newDeployServer(t)
		// Editor: does NOT own the site, but canReplace. Today's `owned` gate aborts here.
		st.existsBody = `{"exists":true,"owned":false,"canReplace":true,"contentVersion":5}`
		c, _ := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n")
		if err := c.deploy([]string{dir}); err != nil {
			t.Fatalf("editor deploy should proceed on canReplace, got: %v", err)
		}
		if st.uploadPath != "/api/upload/acme/doc" {
			t.Fatalf("editor upload did not happen: %q", st.uploadPath)
		}
	})

	t.Run("cli.deploy.notReplaceable.aborts", func(t *testing.T) {
		dir := writePulledDir(t)
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":false,"canReplace":false,"contentVersion":5}`
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{dir}); err == nil {
			t.Error("a non-owner non-editor must still be refused")
		}
		if st.uploadPath != "" {
			t.Error("no upload should happen when canReplace is false")
		}
	})
}
