package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Local mirror of the server ThreadView/CommentView fields the digest reads (the CLI is
// zero-dep, so we don't import from other packages). The full original bytes are kept in `raw`
// so --json passes EVERY server field through untouched, even ones the digest never reads.
type digestComment struct {
	Author  *string `json:"author"` // display name; kept even when deleted
	Body    *string `json:"body"`   // null when soft-deleted
	Deleted bool    `json:"deleted"`
}

type digestThread struct {
	ID       string          `json:"id"`
	FilePath string          `json:"filePath"`
	Quote    *string         `json:"quote"`
	Status   string          `json:"status"` // "open" | "resolved"
	Comments []digestComment `json:"comments"`
	raw      json.RawMessage // the untouched original object, for --json passthrough
}

// Decode a server thread array, keeping each element's original bytes alongside the parsed
// digest fields. Mirrors what the `comments` command feeds renderDigest.
func parseThreads(data []byte) ([]digestThread, error) {
	var raws []json.RawMessage
	if err := json.Unmarshal(data, &raws); err != nil {
		return nil, err
	}
	threads := make([]digestThread, 0, len(raws))
	for _, r := range raws {
		var t digestThread
		if err := json.Unmarshal(r, &t); err != nil {
			return nil, err
		}
		t.raw = r
		threads = append(threads, t)
	}
	return threads, nil
}

// Render a site's comment threads as a markdown digest (or raw JSON). PURE - no I/O.
func renderDigest(threads []digestThread, open, jsonOut bool) (string, error) {
	shown := threads
	if open {
		shown = shown[:0:0]
		for _, t := range threads {
			if t.Status == "open" {
				shown = append(shown, t)
			}
		}
	}

	if jsonOut {
		raws := make([]json.RawMessage, len(shown))
		for i, t := range shown {
			raws[i] = t.raw
		}
		b, err := json.MarshalIndent(raws, "", "  ")
		if err != nil {
			return "", err
		}
		return string(b), nil
	}

	if len(shown) == 0 {
		return "No comments.", nil
	}

	openCount := 0
	for _, t := range shown {
		if t.Status == "open" {
			openCount++
		}
	}
	lines := []string{fmt.Sprintf("# %d open · %d resolved", openCount, len(shown)-openCount)}

	// Group by filePath, preserving first-appearance order, so a file's threads stay adjacent.
	var order []string
	byFile := map[string][]digestThread{}
	for _, t := range shown {
		if _, ok := byFile[t.FilePath]; !ok {
			order = append(order, t.FilePath)
		}
		byFile[t.FilePath] = append(byFile[t.FilePath], t)
	}

	for _, filePath := range order {
		for _, t := range byFile[filePath] {
			lines = append(lines, "", fmt.Sprintf("### %s · %s · %s", filePath, strings.ToUpper(t.Status), t.ID))
			if t.Quote != nil {
				lines = append(lines, `> "`+*t.Quote+`"`) // raw interpolation, matches JS (no escaping)
			}
			for _, c := range t.Comments {
				author := "unknown"
				if c.Author != nil {
					author = *c.Author
				}
				if c.Deleted {
					lines = append(lines, fmt.Sprintf("- @%s (deleted): [deleted]", author))
				} else {
					body := ""
					if c.Body != nil {
						body = *c.Body
					}
					lines = append(lines, fmt.Sprintf("- @%s: %s", author, body))
				}
			}
		}
	}
	return strings.Join(lines, "\n"), nil
}
