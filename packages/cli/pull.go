package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// pullMarker (.glance/pull.json) records where a `read --pull` tree came from, so a later `deploy`
// of that tree targets the same site and passes the pulled contentVersion as the CAS token.
type pullMarker struct {
	Space          string `json:"space"`
	Name           string `json:"name"`
	ContentVersion int    `json:"contentVersion"`
}

const (
	pullMarkerDir  = ".glance"
	pullMarkerFile = "pull.json"
)

// readPullMarker returns the marker a prior --pull wrote under dir, or (nil,false) if absent/unreadable.
func readPullMarker(dir string) (*pullMarker, bool) {
	data, err := os.ReadFile(filepath.Join(dir, pullMarkerDir, pullMarkerFile))
	if err != nil {
		return nil, false
	}
	var m pullMarker
	if json.Unmarshal(data, &m) != nil {
		return nil, false
	}
	return &m, true
}

func writePullMarker(dir string, m pullMarker) error {
	md := filepath.Join(dir, pullMarkerDir)
	if err := os.MkdirAll(md, 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	return os.WriteFile(filepath.Join(md, pullMarkerFile), data, 0o644)
}

// encodePath percent-encodes each POSIX path segment for a content-URL fetch (mirrors a browser
// request), so paths with spaces/unicode resolve.
func encodePath(file string) string {
	segs := strings.Split(strings.TrimLeft(file, "/"), "/")
	for i, s := range segs {
		segs[i] = encodeURIComponent(s)
	}
	return strings.Join(segs, "/")
}
