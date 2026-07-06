package main

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type deployState struct {
	existsBody    string // response body for the /exists endpoint
	existsStatus  int    // status for /exists; 0 -> 200
	spacesMineHit bool
	uploadPath    string
	uploadQuery   string
	visibility    string
	files         map[string]string // rel filename -> contents (unstripped)
}

func newDeployServer(t *testing.T) (*httptest.Server, *deployState) {
	t.Helper()
	st := &deployState{existsBody: `{"exists":false}`, files: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/spaces/mine":
			st.spacesMineHit = true
			io.WriteString(w, `[{"slug":"me","type":"personal"},{"slug":"docs","type":"group"}]`)
		case strings.HasSuffix(r.URL.Path, "/exists"):
			if st.existsStatus != 0 {
				w.WriteHeader(st.existsStatus)
			}
			io.WriteString(w, st.existsBody)
		case strings.HasPrefix(r.URL.Path, "/api/upload/"):
			st.uploadPath = r.URL.Path
			st.uploadQuery = r.URL.RawQuery
			body, _ := io.ReadAll(r.Body)
			_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
			for {
				p, err := mr.NextRawPart()
				if err != nil {
					break
				}
				data, _ := io.ReadAll(p)
				// filename via mime.ParseMediaType (does NOT strip dirs, unlike Part.FileName)
				_, cd, _ := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
				if fn := cd["filename"]; fn != "" {
					st.files[fn] = string(data)
				} else if p.FormName() == "visibility" {
					st.visibility = string(data)
				}
			}
			io.WriteString(w, `{"url":"https://g`+strings.TrimPrefix(r.URL.Path, "/api/upload")+`"}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, st
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDeployCommand(t *testing.T) {
	t.Run("folder-walks-defaults-space-and-name", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "myfolder")
		writeFile(t, filepath.Join(dir, "a.txt"), "AAA")
		writeFile(t, filepath.Join(dir, "sub", "b.txt"), "BBB")
		writeFile(t, filepath.Join(dir, ".git", "cfg"), "SECRET") // must be skipped

		srv, st := newDeployServer(t)
		c, out := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{dir}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if !st.spacesMineHit {
			t.Error("should resolve personal space when --space omitted")
		}
		if st.uploadPath != "/api/upload/me/myfolder" {
			t.Fatalf("uploadPath = %q", st.uploadPath)
		}
		if st.visibility != "team" {
			t.Errorf("visibility = %q, want default team", st.visibility)
		}
		if st.files["a.txt"] != "AAA" || st.files["sub/b.txt"] != "BBB" {
			t.Fatalf("files = %v", st.files)
		}
		if _, leaked := st.files[".git/cfg"]; leaked {
			t.Error(".git contents were uploaded")
		}
		if !strings.Contains(out.String(), "✓ Deployed → https://g/me/myfolder") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("single-file-name-sans-extension", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "<h1>hi</h1>")
		srv, st := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.uploadPath != "/api/upload/me/report" {
			t.Fatalf("uploadPath = %q", st.uploadPath)
		}
		if st.files["report.html"] != "<h1>hi</h1>" {
			t.Fatalf("files = %v", st.files)
		}
	})

	t.Run("exists-owned-replace-yes-adds-query", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":true}`
		c, _ := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n")
		if err := c.deploy([]string{file}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.uploadQuery != "replace=true" {
			t.Fatalf("uploadQuery = %q, want replace=true", st.uploadQuery)
		}
	})

	t.Run("replace-without-visibility-omits-field", func(t *testing.T) {
		// Regression: sending the default "team" on every replace silently re-tiers (e.g. widens a
		// private site) on a routine content update. Without --visibility the field must be omitted.
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":true}`
		c, _ := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n")
		if err := c.deploy([]string{file}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.visibility != "" {
			t.Errorf("replace without --visibility sent visibility=%q; must omit to preserve the tier", st.visibility)
		}
	})

	t.Run("replace-with-explicit-visibility-sends-it", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":true}`
		c, _ := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("y\n")
		if err := c.deploy([]string{file, "--visibility", "private"}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.visibility != "private" {
			t.Errorf("replace with --visibility private sent %q, want private", st.visibility)
		}
	})

	t.Run("create-omitting-visibility-defaults-team", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t) // existsBody defaults to {"exists":false} -> create
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.visibility != "team" {
			t.Errorf("create sent visibility=%q, want team default", st.visibility)
		}
	})

	t.Run("exists-owned-replace-no-cancels", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":true}`
		c, out := newTestClient(srv.URL, "tok")
		c.in = strings.NewReader("\n")
		if err := c.deploy([]string{file}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.uploadPath != "" {
			t.Error("upload should not happen when replace declined")
		}
		if !strings.Contains(out.String(), "Cancelled") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("exists-not-owned-errors", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		st.existsBody = `{"exists":true,"owned":false}`
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file}); err == nil {
			t.Fatal("want error when taken by another user")
		}
		if st.uploadPath != "" {
			t.Error("must not upload over another user's site")
		}
	})

	t.Run("invalid-derived-name-errors", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "ab.md") // -> "ab", too short for a slug
		writeFile(t, file, "x")
		srv, _ := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file}); err == nil {
			t.Fatal("want error: derived name too short")
		}
	})

	t.Run("legacy-visibility-normalized", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file, "--visibility", "group"}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.visibility != "members" {
			t.Fatalf("group should normalize to members, got %q", st.visibility)
		}
	})

	t.Run("dotfiles-skipped-by-default", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "myfolder")
		writeFile(t, filepath.Join(dir, "index.html"), "<h1>hi</h1>")
		writeFile(t, filepath.Join(dir, ".env"), "SECRET=1") // must not ship without opt-in
		srv, st := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{dir}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if _, leaked := st.files[".env"]; leaked {
			t.Error(".env was uploaded without --include-hidden")
		}
		if st.files["index.html"] != "<h1>hi</h1>" {
			t.Fatalf("files = %v", st.files)
		}
	})

	t.Run("include-hidden-uploads-dotfiles", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "myfolder")
		writeFile(t, filepath.Join(dir, "index.html"), "x")
		writeFile(t, filepath.Join(dir, ".npmrc"), "token=abc")
		srv, st := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{dir, "--include-hidden"}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.files[".npmrc"] != "token=abc" {
			t.Fatalf("--include-hidden should upload dotfiles, files = %v", st.files)
		}
	})

	t.Run("symlinks-not-followed", func(t *testing.T) {
		root := t.TempDir()
		secret := filepath.Join(root, "secret.txt") // lives OUTSIDE the deploy dir
		writeFile(t, secret, "TOPSECRET")
		dir := filepath.Join(root, "mysite")
		writeFile(t, filepath.Join(dir, "index.html"), "x")
		if err := os.Symlink(secret, filepath.Join(dir, "leak.txt")); err != nil {
			t.Skipf("symlink unsupported: %v", err)
		}
		srv, st := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{dir}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if _, leaked := st.files["leak.txt"]; leaked {
			t.Error("symlink was followed and its target uploaded (escapes deploy root)")
		}
		if st.files["index.html"] != "x" {
			t.Fatalf("files = %v", st.files)
		}
	})

	t.Run("exists-check-non-ok-aborts", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		st.existsStatus = 500
		st.existsBody = `oops`
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file}); err == nil {
			t.Fatal("want error when the exists precheck returns non-OK")
		}
		if st.uploadPath != "" {
			t.Error("must not upload when the existence check failed")
		}
	})

	t.Run("explicit-space-and-name-skip-resolution", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "report.html")
		writeFile(t, file, "x")
		srv, st := newDeployServer(t)
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.deploy([]string{file, "--space", "docs", "--name", "api-ref"}); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if st.spacesMineHit {
			t.Error("explicit --space must skip personal-space resolution")
		}
		if st.uploadPath != "/api/upload/docs/api-ref" {
			t.Fatalf("uploadPath = %q", st.uploadPath)
		}
	})
}
