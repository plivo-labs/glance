package main

import (
	"encoding/json"
	"fmt"
	"io"
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
	var meta struct {
		ContentURL string `json:"contentUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return err
	}

	// contentUrl always ends with '/'; append the in-site path (empty -> site root / single file).
	// Encode each segment so paths with spaces/unicode resolve, mirroring a browser request.
	segs := strings.Split(strings.TrimLeft(file, "/"), "/")
	for i, s := range segs {
		segs[i] = encodeURIComponent(s)
	}
	path := strings.Join(segs, "/")

	cres, err := c.http.Get(meta.ContentURL + path)
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
