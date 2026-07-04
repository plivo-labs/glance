package main

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const checkIntervalMS = int64(24 * 60 * 60 * 1000)

// UpdateState persists across runs in ~/.glance/update.json.
type UpdateState struct {
	LastCheckedAt     int64  `json:"lastCheckedAt,omitempty"`
	UpdatedTo         string `json:"updatedTo,omitempty"`         // a background swap landed; notice pending
	Available         string `json:"available,omitempty"`         // newer release exists but install dir isn't writable
	NotifiedAvailable string `json:"notifiedAvailable,omitempty"` // version already nagged about (once per version)
}

// Numeric dotted-part compare (release tags are plain vX.Y.Z). Non-numeric parts count as 0, so a
// malformed or non-CLI tag (e.g. a screenshots release) never compares newer and never triggers a swap.
func compareVersions(a, b string) int {
	pa, pb := versionParts(a), versionParts(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if d := x - y; d != 0 {
			return d
		}
	}
	return 0
}

func versionParts(v string) []int {
	segs := strings.Split(v, ".")
	out := make([]int, len(segs))
	for i, s := range segs {
		out[i], _ = strconv.Atoi(s) // non-numeric -> 0 (matches JS `parseInt || 0`)
	}
	return out
}

var tagRe = regexp.MustCompile(`/tag/([^/?#]+)`)

// `<base>/latest` resolves (via redirect) to `.../releases/tag/<tag>` - the tag rides in the final URL.
// Returns "" when there is no /tag/ segment (no releases).
func parseLatestTag(u string) string {
	m := tagRe.FindStringSubmatch(u)
	if m == nil {
		return ""
	}
	if dec, err := url.PathUnescape(m[1]); err == nil {
		return dec
	}
	return m[1]
}

// Release asset naming - must match release.yml: glance-<arm64|x64>-<darwin|linux>. Returns "" for
// unsupported platform/arch. Input follows the JS process.platform/process.arch vocabulary
// ('darwin'/'linux', 'arm64'/'x64'); the caller maps Go's GOARCH ('amd64'->'x64') before calling.
func assetName(platform, arch string) string {
	if platform != "darwin" && platform != "linux" {
		return ""
	}
	if arch != "arm64" && arch != "x64" {
		return ""
	}
	return "glance-" + arch + "-" + platform
}

func shouldCheck(state UpdateState, now int64) bool {
	return state.LastCheckedAt == 0 || now-state.LastCheckedAt > checkIntervalMS
}

// What (if anything) to tell the user this run, and the state to persist after saying it. PURE.
// `changed` is false when nothing changed so the caller can skip the state write.
func planAnnouncement(state UpdateState, current string) (message string, next UpdateState, changed bool) {
	if state.UpdatedTo != "" {
		// Only claim the update if we're actually running it (a manual reinstall may have raced us).
		if state.UpdatedTo == current {
			message = "✓ glance auto-updated to " + current
		}
		next = state
		next.UpdatedTo = ""
		return message, next, true
	}
	if state.Available != "" {
		if compareVersions(state.Available, current) <= 0 {
			next = state
			next.Available = ""
			next.NotifiedAvailable = ""
			return "", next, true
		}
		if state.NotifiedAvailable != state.Available {
			next = state
			next.NotifiedAvailable = state.Available
			return "glance " + state.Available + " is available — run `glance upgrade`", next, true
		}
	}
	return "", state, false
}
