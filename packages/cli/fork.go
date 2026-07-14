package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// fork copies a site you can READ into a space you belong to. Both flags are optional and the
// SERVER owns the defaulting (your personal space, slug `<slug>-copy`, then `-copy-2`, …) - so an
// omitted flag is omitted from the body rather than guessed at here, where a stale guess would
// silently diverge from the server's collision suffixing.
func (c *client) fork(argv []string) error {
	positional, flags := parseArgs(argv, nil)
	target := ""
	if len(positional) > 0 {
		target = positional[0]
	}
	usage := "Usage: glance fork <space/slug> [--space <slug>] [--name <slug>]"
	space, name, err := splitSpaceSlug(target)
	if err != nil {
		return fmt.Errorf("%s", usage)
	}

	// `--name` is the NEW site slug (same meaning as `deploy --name`). Validate it up front with the
	// same rule the server applies, so a typo reads as a usage error instead of a bare 400.
	body := map[string]string{}
	if raw, present := flags["space"]; present {
		dest := raw.(string)
		if dest == "" {
			return fmt.Errorf("%s", usage)
		}
		body["space"] = dest
	}
	if raw, present := flags["name"]; present {
		newName := raw.(string)
		if !isValidSlug(newName) {
			return fmt.Errorf("Invalid --name %q. Use a slug (lowercase, 3–40 chars).", newName)
		}
		body["slug"] = newName
	}
	if err := c.requireAuth(); err != nil {
		return err
	}

	payload, _ := json.Marshal(body)
	resp, err := c.authed("POST", "/api/sites/"+space+"/"+name+"/fork",
		strings.NewReader(string(payload)), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Fork failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "✓ Forked → %s\n", out.URL)
	return nil
}
