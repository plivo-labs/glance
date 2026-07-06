package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
)

type deployEntry struct {
	abs string
	rel string // POSIX in-site path
}

// walk lists regular files under dir recursively. It always skips VCS/build noise (.git,
// node_modules, .DS_Store) and NEVER follows symlinks - a symlink could point outside the deploy
// root (e.g. /etc/passwd or ~/.ssh) and leak its target. Unless includeHidden is set it also skips
// dotfiles/dot-dirs (.env, .npmrc, .netrc, …) so secrets aren't uploaded by accident.
func walk(dir string, includeHidden bool) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if name == ".git" || name == "node_modules" || name == ".DS_Store" {
			continue
		}
		if !includeHidden && strings.HasPrefix(name, ".") {
			continue
		}
		if e.Type()&os.ModeSymlink != 0 {
			continue // don't follow symlinks (target may escape the deploy root)
		}
		abs := filepath.Join(dir, name)
		if e.IsDir() {
			sub, err := walk(abs, includeHidden)
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		} else {
			out = append(out, abs)
		}
	}
	return out, nil
}

// personalSpace resolves the caller's personal space - the default target when --space is omitted.
func (c *client) personalSpace() (string, error) {
	resp, err := c.authed("GET", "/api/spaces/mine", nil, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return "", fmt.Errorf("Could not resolve your space (%d). Pass --space <slug>.", resp.StatusCode)
	}
	var spaces []struct {
		Slug string `json:"slug"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&spaces); err != nil {
		return "", err
	}
	if len(spaces) == 0 {
		return "", fmt.Errorf("No space found for your account. Pass --space <slug>.")
	}
	for _, s := range spaces {
		if s.Type == "personal" {
			return s.Slug, nil
		}
	}
	return spaces[0].Slug, nil
}

func (c *client) deploy(argv []string) error {
	positional, flags := parseArgs(argv, boolSet("include-hidden"))
	path := ""
	if len(positional) > 0 {
		path = positional[0]
	}
	includeHidden := flags["include-hidden"] == true

	visibility := "team"
	visibilitySet := false
	if raw, present := flags["visibility"]; present {
		visibility = raw.(string)
		visibilitySet = true
	}
	// `group` was renamed to `members`; keep old commands working (server normalizes too).
	if visibility == "group" {
		fmt.Fprintln(c.errOut, "note: --visibility group is now 'members' (this space's people) — using members.")
		visibility = "members"
	}
	// The `public` tier was removed (no anonymous access); old scripts fall back to `team`.
	if visibility == "public" {
		fmt.Fprintln(c.errOut, "note: --visibility public was removed — using team (everyone in your org).")
		visibility = "team"
	}
	if path == "" {
		return fmt.Errorf("Usage: glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|private|members] [--include-hidden]")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}

	root, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	info, err := os.Stat(root)
	if err != nil {
		return fmt.Errorf("No such file or directory: %s", root)
	}

	// Accept a single file OR a folder. A lone file uploads under its own name and is served at
	// the site root (the content worker falls back to the only file).
	var entries []deployEntry
	var derived string
	if info.IsDir() {
		files, err := walk(root, includeHidden)
		if err != nil {
			return err
		}
		for _, abs := range files {
			rel, _ := filepath.Rel(root, abs)
			entries = append(entries, deployEntry{abs: abs, rel: filepath.ToSlash(rel)})
		}
		derived = filepath.Base(root)
	} else {
		base := filepath.Base(root)
		entries = []deployEntry{{abs: root, rel: base}}
		derived = strings.TrimSuffix(base, filepath.Ext(base)) // default name = file name, sans extension
	}
	if len(entries) == 0 {
		return fmt.Errorf("No files to upload.")
	}

	name := ""
	if raw, present := flags["name"]; present {
		name = raw.(string)
	} else {
		name = slugify(derived)
	}
	if !isValidSlug(name) {
		return fmt.Errorf("Couldn't derive a valid name from %q. Pass --name <slug> (lowercase, 3–40 chars).", filepath.Base(root))
	}

	space := ""
	if raw, present := flags["space"]; present {
		space = raw.(string)
	} else {
		s, err := c.personalSpace()
		if err != nil {
			return err
		}
		space = s
	}

	// Replace prompt if the site already exists and the caller owns it. Don't treat a failed check
	// as "does not exist": a non-2xx status or an undecodable body must abort, not silently upload
	// (which could clobber a site or race an unexpected server state).
	exResp, err := c.authed("GET", "/api/sites/"+space+"/"+name+"/exists", nil, nil)
	if err != nil {
		return err
	}
	if !ok(exResp) {
		code := exResp.StatusCode
		exResp.Body.Close()
		return fmt.Errorf("Could not check whether %s/%s already exists (%d).", space, name, code)
	}
	var ex struct {
		Exists bool `json:"exists"`
		Owned  bool `json:"owned"`
	}
	decErr := json.NewDecoder(exResp.Body).Decode(&ex)
	exResp.Body.Close()
	if decErr != nil {
		return fmt.Errorf("Could not read the existence check for %s/%s: %w", space, name, decErr)
	}
	replace := false
	if ex.Exists {
		if !ex.Owned {
			return fmt.Errorf("%s/%s is taken by another user.", space, name)
		}
		ans := c.prompt(fmt.Sprintf("Site exists at %s/%s. Replace? (y/N) ", space, name))
		if strings.ToLower(ans) != "y" {
			fmt.Fprintln(c.out, "Cancelled.")
			return nil
		}
		replace = true
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	// Send visibility on create, but on replace only when --visibility was explicitly passed. The
	// default is "team", so unconditionally sending it would silently re-tier an existing (e.g.
	// private) site to team on a routine content update. Absent on replace → server keeps the tier.
	if visibilitySet || !replace {
		_ = mw.WriteField("visibility", visibility)
	}
	for _, e := range entries {
		data, err := os.ReadFile(e.abs)
		if err != nil {
			return err
		}
		fw, err := mw.CreateFormFile("files", e.rel)
		if err != nil {
			return err
		}
		if _, err := fw.Write(data); err != nil {
			return err
		}
	}
	if err := mw.Close(); err != nil {
		return err
	}

	fmt.Fprintf(c.out, "Uploading %d file(s) to %s/%s…\n", len(entries), space, name)
	for _, e := range entries {
		fmt.Fprintf(c.out, "  %s\n", e.rel) // surface the exact set so the user isn't blind to what ships
	}
	uploadPath := "/api/upload/" + space + "/" + name
	if replace {
		uploadPath += "?replace=true"
	}
	resp, err := c.authed("POST", uploadPath, &body, map[string]string{"Content-Type": mw.FormDataContentType()})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Upload failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "✓ Deployed → %s\n", out.URL)
	return nil
}
