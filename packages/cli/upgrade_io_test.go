package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// releaseAssets serves the GitHub-shaped release layout: /latest redirects to /tag/<tag>, and
// /download/<tag>/<asset>{.gz,.sha256}. sumOverride (if non-empty) replaces the real checksum.
func releaseAssets(t *testing.T, tag string, binary []byte, sumOverride string) *httptest.Server {
	t.Helper()
	asset := assetName(goAssetPlatform(), goAssetArch())
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(binary)
	_ = zw.Close()
	sum := sha256.Sum256(binary)
	sha := hex.EncodeToString(sum[:])
	if sumOverride != "" {
		sha = sumOverride
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/latest":
			http.Redirect(w, r, srv.URL+"/tag/"+tag, http.StatusFound)
		case r.URL.Path == "/download/"+tag+"/"+asset+".gz":
			_, _ = w.Write(gz.Bytes())
		case r.URL.Path == "/download/"+tag+"/"+asset+".sha256":
			_, _ = io.WriteString(w, sha+"  "+asset)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchLatestTag(t *testing.T) {
	srv := releaseAssets(t, "v1.4.2", []byte("x"), "")
	tag, err := fetchLatestTag(srv.URL)
	if err != nil {
		t.Fatalf("fetchLatestTag: %v", err)
	}
	if tag != "v1.4.2" {
		t.Fatalf("tag = %q, want v1.4.2 (via redirect)", tag)
	}
}

func TestDownloadAndSwap(t *testing.T) {
	t.Run("verifies-and-atomically-replaces", func(t *testing.T) {
		newBinary := []byte("NEW-BINARY-CONTENTS-v2")
		srv := releaseAssets(t, "v2.0.0", newBinary, "")

		target := filepath.Join(t.TempDir(), "glance")
		if err := os.WriteFile(target, []byte("OLD-v1"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := downloadAndSwap(srv.URL, "v2.0.0", target); err != nil {
			t.Fatalf("downloadAndSwap: %v", err)
		}
		got, _ := os.ReadFile(target)
		if string(got) != string(newBinary) {
			t.Fatalf("target = %q, want new binary", got)
		}
		info, _ := os.Stat(target)
		if info.Mode().Perm()&0o100 == 0 {
			t.Errorf("swapped binary not executable: %v", info.Mode())
		}
	})

	t.Run("checksum-mismatch-leaves-target-untouched", func(t *testing.T) {
		srv := releaseAssets(t, "v2.0.0", []byte("NEW"), strings.Repeat("a", 64)) // wrong sha

		target := filepath.Join(t.TempDir(), "glance")
		_ = os.WriteFile(target, []byte("OLD-v1"), 0o755)
		if err := downloadAndSwap(srv.URL, "v2.0.0", target); err == nil {
			t.Fatal("want error on checksum mismatch")
		}
		got, _ := os.ReadFile(target)
		if string(got) != "OLD-v1" {
			t.Fatalf("target was modified on failed verify: %q", got)
		}
		// the temp file must not be left behind
		entries, _ := os.ReadDir(filepath.Dir(target))
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".glance-update-") {
				t.Errorf("leftover temp file: %s", e.Name())
			}
		}
	})

	t.Run("missing-asset-errors", func(t *testing.T) {
		srv := releaseAssets(t, "v2.0.0", []byte("NEW"), "")
		target := filepath.Join(t.TempDir(), "glance")
		_ = os.WriteFile(target, []byte("OLD"), 0o755)
		if err := downloadAndSwap(srv.URL, "v9.9.9", target); err == nil { // wrong tag -> 404
			t.Fatal("want error when the asset is missing")
		}
	})

	t.Run("e2e-swapped-binary-actually-runs", func(t *testing.T) {
		// Compile a real helper program, publish it as the release asset, swap it over a target,
		// then EXEC the target - proving rename(2) yields a runnable binary (the whole point).
		buildDir := t.TempDir()
		src := filepath.Join(buildDir, "main.go")
		_ = os.WriteFile(src, []byte("package main\nimport \"fmt\"\nfunc main(){fmt.Print(\"SWAPPED-OK\")}\n"), 0o644)
		newBin := filepath.Join(buildDir, "newbin")
		build := exec.Command("go", "build", "-o", newBin, src)
		build.Dir = buildDir
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("go build helper: %v\n%s", err, out)
		}
		binBytes, _ := os.ReadFile(newBin)

		srv := releaseAssets(t, "v2.0.0", binBytes, "")
		target := filepath.Join(t.TempDir(), "glance")
		_ = os.WriteFile(target, []byte("#!/bin/sh\necho OLD\n"), 0o755)

		if err := downloadAndSwap(srv.URL, "v2.0.0", target); err != nil {
			t.Fatalf("downloadAndSwap: %v", err)
		}
		out, err := exec.Command(target).Output()
		if err != nil {
			t.Fatalf("exec swapped binary: %v", err)
		}
		if string(out) != "SWAPPED-OK" {
			t.Fatalf("swapped binary output = %q", out)
		}
	})
}

func TestUpdateStateRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := readState(); got != (UpdateState{}) {
		t.Fatalf("empty state = %+v", got)
	}
	saveState(UpdateState{LastCheckedAt: 42, UpdatedTo: "1.2.3"})
	got := readState()
	if got.LastCheckedAt != 42 || got.UpdatedTo != "1.2.3" {
		t.Fatalf("roundtrip = %+v", got)
	}
}

func TestUpgradeDevGuard(t *testing.T) {
	// version is "0.0.0-dev" under `go test`, so isInstalledBinary() is false: a foreground upgrade
	// must error loudly, but a background (--quiet) pass must stay silent (return nil).
	c, _ := newTestClient("http://unused", "")
	if err := c.upgradeCmd([]string{}); err == nil {
		t.Error("foreground upgrade on a dev build should error")
	}
	if err := c.upgradeCmd([]string{"--quiet"}); err != nil {
		t.Errorf("background upgrade on a dev build should be silent, got %v", err)
	}
}
