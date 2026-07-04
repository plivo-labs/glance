package main

import (
	"regexp"
	"strings"
)

// Derive a Glance site slug from a file/folder name. Mirrors the server's rule
// (api lib/slug.ts): lowercase alphanumeric + hyphens, 3-40 chars, no edge hyphen.
var (
	slugNonAlnum = regexp.MustCompile(`[^a-z0-9-]+`)
	slugDashRun  = regexp.MustCompile(`-{2,}`)
	slugRe       = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`)
)

func slugify(raw string) string {
	s := strings.ToLower(raw)
	s = slugNonAlnum.ReplaceAllString(s, "-")
	s = slugDashRun.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 40 {
		s = s[:40]
	}
	return strings.TrimRight(s, "-")
}

func isValidSlug(s string) bool {
	return slugRe.MatchString(s)
}
