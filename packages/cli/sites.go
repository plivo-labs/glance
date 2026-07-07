package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"strings"
)

// prompt writes a question to the output sink and reads one trimmed line from the input source.
func (c *client) prompt(question string) string {
	fmt.Fprint(c.out, question)
	line, _ := bufio.NewReader(c.in).ReadString('\n')
	return strings.TrimSpace(line)
}

// splitSpaceSlug parses a `<space/slug>` target into exactly two non-empty segments. A loose
// `strings.Contains(target, "/")` + `Split` would silently truncate extra segments (`a/b/c` -> a/b)
// or accept `a/` / `/b`, sending a malformed path to the server; this rejects those up front.
func splitSpaceSlug(target string) (space, slug string, err error) {
	segs := strings.Split(target, "/")
	if len(segs) != 2 || segs[0] == "" || segs[1] == "" {
		return "", "", fmt.Errorf("Expected <space/slug>, got %q", target)
	}
	return segs[0], segs[1], nil
}

func (c *client) del(argv []string) error {
	target := ""
	if len(argv) > 0 {
		target = argv[0]
	}
	space, name, err := splitSpaceSlug(target)
	if err != nil {
		return fmt.Errorf("Usage: glance delete <space/slug>")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	ans := c.prompt(fmt.Sprintf("Delete %s/%s? (y/N) ", space, name))
	if strings.ToLower(ans) != "y" {
		fmt.Fprintln(c.out, "Cancelled.")
		return nil
	}
	resp, err := c.authed("DELETE", "/api/sites/"+space+"/"+name, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Delete failed (%d)", resp.StatusCode)
	}
	fmt.Fprintln(c.out, "✓ Deleted.")
	return nil
}

func (c *client) move(argv []string) error {
	target, dest := "", ""
	if len(argv) > 0 {
		target = argv[0]
	}
	if len(argv) > 1 {
		dest = argv[1]
	}
	space, name, err := splitSpaceSlug(target)
	if err != nil || dest == "" {
		return fmt.Errorf("Usage: glance move <space/slug> <new-space>")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"space": dest})
	resp, err := c.authed("POST", "/api/sites/"+space+"/"+name+"/move",
		strings.NewReader(string(payload)), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Move failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "✓ Moved → %s\n", out.URL)
	return nil
}
