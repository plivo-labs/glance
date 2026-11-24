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
		return fmt.Errorf("Cancelled: %s/%s was not deleted.", space, name)
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

// archive / unarchive shelve and restore the caller's own page (PATCH {archived}). The page answers 410
// while archived and nothing is deleted. An admin's own archive is not the owner's to lift: the server
// answers 403 and says so.
func (c *client) archive(argv []string) error   { return c.setArchived(argv, true) }
func (c *client) unarchive(argv []string) error { return c.setArchived(argv, false) }

func (c *client) setArchived(argv []string, archived bool) error {
	verb := "unarchive"
	if archived {
		verb = "archive"
	}
	target := ""
	if len(argv) > 0 {
		target = argv[0]
	}
	space, name, err := splitSpaceSlug(target)
	if err != nil {
		return fmt.Errorf("Usage: glance %s <space/slug>", verb)
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]bool{"archived": archived})
	resp, err := c.authed("PATCH", "/api/sites/"+space+"/"+name,
		strings.NewReader(string(payload)), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("%s failed (%d): %s", strings.ToUpper(verb[:1])+verb[1:], resp.StatusCode, bodySlice(resp))
	}
	if archived {
		fmt.Fprintf(c.out, "✓ Archived %s/%s. It answers 410 until you run: glance unarchive %s/%s\n", space, name, space, name)
	} else {
		fmt.Fprintf(c.out, "✓ Unarchived %s/%s.\n", space, name)
	}
	return nil
}
