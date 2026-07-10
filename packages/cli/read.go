package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// read prints a deployed file's raw contents. Every tier is gated (no anonymous access), so the
// meta endpoint (authed) mints a content URL carrying a short-lived user-bound token in the path;
// the content fetch itself is UNauthenticated (the path carries the auth, as the iframe does).
func (c *client) read(argv []string) error {
	positional, flags := parseArgs(argv, nil)
	target := ""
	if len(positional) > 0 {
		target = positional[0]
	}
	space, name, err := splitSpaceSlug(target)
	if err != nil {
		return fmt.Errorf("Usage: glance read <space/slug> [--file <path>]")
	}
	file, _ := flags["file"].(string)
	pullDir, doPull := flags["pull"].(string)
	if err := c.requireAuth(); err != nil {
		return err
	}

	resp, err := c.authed("GET", "/api/sites/"+space+"/"+name, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Could not read %s/%s (%d): %s", space, name, resp.StatusCode, bodySlice(resp))
	}
	// files[] + contentVersion are present only when the caller may replace (owner/editor/superadmin) —
	// the manifest the pull needs. A plain viewer gets neither, so --pull refuses (below).
	var meta struct {
		ContentURL     string   `json:"contentUrl"`
		Files          []string `json:"files"`
		ContentVersion int      `json:"contentVersion"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return err
	}

	if doPull {
		return c.pullTree(space, name, pullDir, meta.ContentURL, meta.Files, meta.ContentVersion)
	}

	// contentUrl always ends with '/'; append the in-site path (empty -> site root / single file).
	cres, err := c.http.Get(meta.ContentURL + encodePath(file))
	if err != nil {
		return err
	}
	defer cres.Body.Close()
	if !ok(cres) {
		label := file
		if label == "" {
			label = "site root"
		}
		return fmt.Errorf("Could not fetch %s (%d): %s", label, cres.StatusCode, bodySlice(cres))
	}
	body, err := io.ReadAll(cres.Body)
	if err != nil {
		return err
	}
	_, err = c.out.Write(body) // raw bytes, no trailing newline (pipes cleanly)
	return err
}

// pullTree downloads the whole site source into dir: each manifest file is fetched RAW (?raw=1 —
// the .md source, not its rendered HTML) so a later `deploy` round-trips byte-identically, then a
// .glance/pull.json marker records the site + version for a versioned redeploy. Dotfiles are written
// as-is (the tree is trusted local output). Refuses when the manifest is empty — a plain viewer can't
// see it, and there's nothing to pull.
func (c *client) pullTree(space, name, dir, contentURL string, files []string, version int) error {
	if len(files) == 0 {
		return fmt.Errorf("Can't pull %s/%s: you need owner or editor access (no file manifest was returned).", space, name)
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	for _, rel := range files {
		// Defense-in-depth: a manifest path is server-provided; never let one escape the target dir
		// (e.g. "../../.ssh/authorized_keys"). Upload already sanitizes paths, but a filesystem write
		// driven by a network response must contain itself.
		dest := filepath.Join(root, filepath.FromSlash(rel))
		if dest != root && !strings.HasPrefix(dest, root+string(os.PathSeparator)) {
			return fmt.Errorf("refusing to write outside %s: %s", dir, rel)
		}
		cres, err := c.http.Get(contentURL + encodePath(rel) + "?raw=1")
		if err != nil {
			return err
		}
		if !ok(cres) {
			code := cres.StatusCode
			cres.Body.Close()
			return fmt.Errorf("Could not pull %s (%d)", rel, code)
		}
		body, err := io.ReadAll(cres.Body)
		cres.Body.Close()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, body, 0o644); err != nil {
			return err
		}
	}
	if err := writePullMarker(dir, pullMarker{Space: space, Name: name, ContentVersion: version}); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "Pulled %d file(s) → %s\n", len(files), dir)
	return nil
}
