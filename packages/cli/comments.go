package main

import (
	"fmt"
	"io"
	"strings"
)

func (c *client) comments(argv []string) error {
	positional, flags := parseArgs(argv, boolSet("open", "json"))
	target := ""
	if len(positional) > 0 {
		target = positional[0]
	}
	if !strings.Contains(target, "/") {
		return fmt.Errorf("Usage: glance comments <space/slug> [--file <path>] [--open] [--json]")
	}
	parts := strings.Split(target, "/")
	space, name := parts[0], parts[1]
	if err := c.requireAuth(); err != nil {
		return err
	}

	query := ""
	if file, isStr := flags["file"].(string); isStr && file != "" {
		query = "?filePath=" + encodeURIComponent(file)
	}
	resp, err := c.authed("GET", "/api/sites/"+space+"/"+name+"/comments"+query, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Failed to fetch comments (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	threads, err := parseThreads(data)
	if err != nil {
		return err
	}
	digest, err := renderDigest(threads, flags["open"] == true, flags["json"] == true)
	if err != nil {
		return err
	}
	fmt.Fprintln(c.out, digest)
	return nil
}
