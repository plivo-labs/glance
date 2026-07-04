package main

import "testing"

// slugify + SLUG_RE mirror the server rule (api lib/slug.ts): lowercase alnum + hyphens,
// 3-40 chars, no edge hyphen. Not unit-tested on the TS side; these pin the JS semantics
// the Go port must reproduce (deploy derives --name from a file/folder name via slugify).
func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"My Report":      "my-report",      // lowercase + space -> hyphen
		"my report.html": "my-report-html", // '.' is non-alnum -> hyphen (extension already stripped by caller)
		"a  b":           "a-b",            // runs of non-alnum collapse to one hyphen
		"a--b":           "a-b",            // pre-existing double hyphen collapses
		"-hi-":           "hi",             // edge hyphens trimmed
		"  spaced  ":     "spaced",         // leading/trailing whitespace -> trimmed hyphens
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsValidSlug(t *testing.T) {
	valid := []string{"abc", "a-b", "my-report", "a1b"}
	invalid := []string{"ab", "a", "", "-ab", "ab-", "-", "UPPER"}
	for _, s := range valid {
		if !isValidSlug(s) {
			t.Errorf("isValidSlug(%q) = false, want true", s)
		}
	}
	for _, s := range invalid {
		if isValidSlug(s) {
			t.Errorf("isValidSlug(%q) = true, want false", s)
		}
	}
}
