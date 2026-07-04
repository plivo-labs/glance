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
	existsBody    string // response for the /exists endpoint
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
