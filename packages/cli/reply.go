package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// reply posts a reply to an existing comment thread. stdin is the recommended channel for
// agent/arbitrary bodies; it's read only when no positional message was given AND stdin isn't a
// TTY - otherwise a bare `glance reply a/b t1` at a prompt would silently hang on stdin.
func (c *client) reply(argv []string) error {
	parsed, err := parseReplyArgs(argv)
	if err != nil {
		return err
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	var stdinBody *string
	if parsed.message == nil {
		if c.stdinIsTTY {
			return errors.New("No reply body. Pass a message argument or pipe one via stdin.")
		}
		b, err := io.ReadAll(c.stdin)
		if err != nil {
			return err
		}
		s := string(b)
		stdinBody = &s
	}
	body, err := resolveReplyBody(parsed.message, stdinBody, parsed.tag, parsed.noTag)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"body": body})
	path := "/api/sites/" + parsed.space + "/" + parsed.site + "/comments/" + encodeURIComponent(parsed.threadID) + "/replies"
	resp, err := c.authed("POST", path, strings.NewReader(string(payload)), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Reply failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	fmt.Fprintf(c.out, "✓ Replied to %s\n", parsed.threadID)
	return nil
}

// Positional message wins over stdin; trim and reject empty BEFORE tagging so a tag can't
// rescue an empty body; then apply the attribution prefix. No client-side length cap - the
// server's MAX_COMMENT_BODY surfaces via the request error. PURE - no I/O.
func resolveReplyBody(message, stdin, tag *string, noTag bool) (string, error) {
	raw := ""
	if message != nil {
		raw = *message
	} else if stdin != nil {
		raw = *stdin
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("Empty reply body. Pass a message or pipe one via stdin.")
	}
	if noTag {
		return trimmed, nil
	}
	label := "agent"
	if tag != nil {
		label = *tag
	}
	return fmt.Sprintf("[%s] %s", label, trimmed), nil
}

const replyUsage = "Usage: glance reply <space/slug> <threadId> [message] [--tag <label> | --no-tag]"

type replyArgs struct {
	space    string
	site     string
	threadID string
	message  *string // nil = not provided (falls back to stdin)
	tag      *string // nil = no --tag flag
	noTag    bool
}

// A reply carries a free-form message that the generic flag parser can't handle safely
// (dash-leading text, `--tag`/`--no-tag`), so it gets its own parser. Positionals are pinned:
// [0]=space/slug, [1]=threadId, [2]=message. A `--` sentinel stops flag parsing so a
// dash-leading or literal message survives. PURE - no I/O.
func parseReplyArgs(argv []string) (*replyArgs, error) {
	var positional []string
	var tag string
	sawTag, noTag, literal := false, false, false
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch {
		case !literal && a == "--":
			literal = true // everything after `--` is a literal positional
		case !literal && strings.HasPrefix(a, "--"):
			key := a[2:]
			switch key {
			case "no-tag":
				noTag = true
			case "tag":
				sawTag = true
				if i+1 < len(argv) {
					i++
					tag = argv[i]
				} else {
					tag = "" // trailing `--tag` -> "" -> rejected below (needs a label)
				}
			default:
				return nil, errors.New("Unknown flag: " + a + "\n" + replyUsage)
			}
		default:
			positional = append(positional, a)
		}
	}
	if sawTag && noTag {
		return nil, errors.New("Use either --tag or --no-tag, not both.\n" + replyUsage)
	}
	if sawTag && tag == "" {
		return nil, errors.New("--tag needs a label, e.g. --tag claude.\n" + replyUsage)
	}

	// Exactly two non-empty segments - never a loose "contains a slash" check, which would let
	// `acme/` or `/doc` through.
	var segs []string
	if len(positional) > 0 {
		segs = strings.Split(positional[0], "/")
	}
	if len(segs) != 2 || segs[0] == "" || segs[1] == "" {
		return nil, errors.New("Expected <space/slug>.\n" + replyUsage)
	}
	if len(positional) < 2 || positional[1] == "" {
		return nil, errors.New("Missing <threadId> (see `glance comments`).\n" + replyUsage)
	}

	out := &replyArgs{space: segs[0], site: segs[1], threadID: positional[1], noTag: noTag}
	if len(positional) >= 3 {
		out.message = &positional[2]
	}
	if sawTag {
		out.tag = &tag
	}
	return out, nil
}
