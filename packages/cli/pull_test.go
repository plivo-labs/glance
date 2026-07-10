package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// S-E seam: an httptest fake for the meta (manifest) + gated raw-content endpoints that `read --pull`
// consumes. The raw path returns DIFFERENT bytes for ?raw=1 (source) vs a plain GET (rendered) so a
// test can prove the pull fetched the source.
func newPullServer(t *testing.T, files map[string]string, contentVersion int, canReplace bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/sites/") && !strings.HasSuffix(r.URL.Path, "/exists"):
			paths := make([]string, 0, len(files))
			for p := range files {
				paths = append(paths, p)
			}
			resp := map[string]any{
				"contentUrl": "http://" + r.Host + "/_c/sam/site/",
				"canReplace": canReplace,
			}
			if canReplace { // manifest gated to owner/editor/superadmin
				resp["files"] = paths
				resp["contentVersion"] = contentVersion
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/_c/sam/site/"):
			rel := strings.TrimPrefix(r.URL.Path, "/_c/sam/site/")
			if r.URL.Query().Get("raw") == "1" {
				_, _ = w.Write([]byte(files[rel]))
			} else {
				_, _ = w.Write([]byte("<h1>RENDERED " + rel + "</h1>")) // non-raw path renders
			}
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestReadPull(t *testing.T) {
	t.Run("cli.pull.writesTree", func(t *testing.T) {
		files := map[string]string{"index.html": "<p>home</p>", "docs/guide.md": "# guide", ".well-known/x": "keep"}
		srv := newPullServer(t, files, 7, true)
		c, _ := newTestClient(srv.URL, "tok")
		dir := t.TempDir()
		if err := c.read([]string{"sam/site", "--pull", dir}); err != nil {
			t.Fatalf("pull: %v", err)
		}
		for rel, want := range files {
			got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
			if err != nil {
				t.Fatalf("missing pulled file %s: %v", rel, err)
			}
			if string(got) != want {
				t.Errorf("%s = %q, want %q", rel, got, want)
			}
		}
		// pull marker records space/name/contentVersion for a later versioned redeploy.
		markerBytes, err := os.ReadFile(filepath.Join(dir, ".glance", "pull.json"))
		if err != nil {
			t.Fatalf("no pull.json: %v", err)
		}
		var pj struct {
			Space          string `json:"space"`
			Name           string `json:"name"`
			ContentVersion int    `json:"contentVersion"`
		}
		if err := json.Unmarshal(markerBytes, &pj); err != nil {
			t.Fatal(err)
		}
		if pj.Space != "sam" || pj.Name != "site" || pj.ContentVersion != 7 {
			t.Errorf("pull.json = %+v", pj)
		}
	})

	t.Run("cli.pull.md.source", func(t *testing.T) {
		srv := newPullServer(t, map[string]string{"about.md": "# real source"}, 1, true)
		c, _ := newTestClient(srv.URL, "tok")
		dir := t.TempDir()
		if err := c.read([]string{"sam/site", "--pull", dir}); err != nil {
			t.Fatalf("pull: %v", err)
		}
		got, _ := os.ReadFile(filepath.Join(dir, "about.md"))
		if string(got) != "# real source" {
			t.Errorf("pulled .md = %q, want the raw source (not rendered HTML)", got)
		}
	})

	t.Run("cli.pull.viewer.denied", func(t *testing.T) {
		srv := newPullServer(t, map[string]string{"index.html": "x"}, 0, false) // canReplace:false → no manifest
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.read([]string{"sam/site", "--pull", t.TempDir()}); err == nil {
			t.Error("a viewer (no manifest) should not be able to --pull")
		}
	})

	t.Run("cli.pull.traversal.refused", func(t *testing.T) {
		// A hostile/buggy manifest path must never write outside the target dir.
		srv := newPullServer(t, map[string]string{"../escape.txt": "pwned"}, 0, true)
		c, _ := newTestClient(srv.URL, "tok")
		dir := t.TempDir()
		if err := c.read([]string{"sam/site", "--pull", filepath.Join(dir, "site")}); err == nil {
			t.Error("a path escaping the target dir must be refused")
		}
		if _, err := os.Stat(filepath.Join(dir, "escape.txt")); err == nil {
			t.Error("traversal write landed outside the target dir")
		}
	})
}

func TestReadUnchanged(t *testing.T) {
	// cli.read.unchanged: a bare `read --file` (no --pull) still prints the served bytes verbatim.
	t.Run("cli.read.unchanged", func(t *testing.T) {
		srv := newPullServer(t, map[string]string{"a.txt": "AAA"}, 0, true)
		c, out := newTestClient(srv.URL, "tok")
		if err := c.read([]string{"sam/site", "--file", "a.txt"}); err != nil {
			t.Fatalf("read: %v", err)
		}
		// bare read hits the NON-raw content path → serves the file (here the fake "renders" it).
		if got := out.String(); got != "<h1>RENDERED a.txt</h1>" {
			t.Errorf("read output = %q", got)
		}
	})
}
