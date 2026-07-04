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

// walk lists files under dir recursively, skipping .git, node_modules, and .DS_Store.
func walk(dir string) ([]string, error) {
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
		abs := filepath.Join(dir, name)
		if e.IsDir() {
			sub, err := walk(abs)
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
	positional, flags := parseArgs(argv, nil)
	path := ""
	if len(positional) > 0 {
		path = positional[0]
	}

	visibility := "team"
	if raw, present := flags["visibility"]; present {
		visibility = raw.(string)
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
		return fmt.Errorf("Usage: glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|private|members]")
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
		files, err := walk(root)
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

	// Replace prompt if the site already exists and the caller owns it.
	replace := false
	if exResp, err := c.authed("GET", "/api/sites/"+space+"/"+name+"/exists", nil, nil); err == nil {
		var ex struct {
			Exists bool `json:"exists"`
			Owned  bool `json:"owned"`
		}
		_ = json.NewDecoder(exResp.Body).Decode(&ex)
		exResp.Body.Close()
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
	} else {
		return err
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("visibility", visibility)
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
