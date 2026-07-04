package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// mustThreads decodes a full server-shape thread array the way the `comments` command does,
// so the --json passthrough test genuinely round-trips real bytes.
func mustThreads(t *testing.T, jsonArr string) []digestThread {
	t.Helper()
	threads, err := parseThreads([]byte(jsonArr))
	if err != nil {
		t.Fatalf("parseThreads: %v", err)
	}
	return threads
}

func TestRenderDigest(t *testing.T) {
	t.Run("groups-by-file-with-counts", func(t *testing.T) {
		// interleaved (one.md, two.md, one.md) so grouping is genuinely exercised
		threads := mustThreads(t, `[
			{"id":"a","filePath":"one.md","quote":"q","status":"open","comments":[]},
			{"id":"b","filePath":"two.md","quote":"q","status":"resolved","comments":[]},
			{"id":"c","filePath":"one.md","quote":"q","status":"open","comments":[]}
		]`)
		out, _ := renderDigest(threads, false, false)
		for _, want := range []string{"one.md", "two.md", "2 open", "1 resolved"} {
			if !strings.Contains(out, want) {
				t.Errorf("output missing %q:\n%s", want, out)
			}
		}
		// both one.md threads stay adjacent (before two.md)
		if strings.LastIndex(out, "one.md") >= strings.Index(out, "two.md") {
			t.Errorf("grouping broken:\n%s", out)
		}
	})

	t.Run("open-filter-hides-resolved-and-body", func(t *testing.T) {
		threads := mustThreads(t, `[
			{"id":"a","filePath":"one.md","quote":null,"status":"open","comments":[]},
			{"id":"b","filePath":"two.md","quote":null,"status":"resolved","comments":[{"author":"Bob","body":"SECRET_RESOLVED_BODY","deleted":false}]}
		]`)
		out, _ := renderDigest(threads, true, false)
		if strings.Contains(out, "two.md") || strings.Contains(out, "SECRET_RESOLVED_BODY") {
			t.Errorf("resolved thread leaked with --open:\n%s", out)
		}
		if !strings.Contains(out, "one.md") {
			t.Errorf("open thread missing:\n%s", out)
		}
	})

	t.Run("deleted-marker-never-leaks-body", func(t *testing.T) {
		threads := mustThreads(t, `[
			{"id":"a","filePath":"one.md","quote":null,"status":"open","comments":[{"author":"Ada","body":"SECRET_DELETED_BODY","deleted":true}]}
		]`)
		out, _ := renderDigest(threads, false, false)
		if !strings.Contains(out, "(deleted)") || !strings.Contains(out, "[deleted]") {
			t.Errorf("deleted marker missing:\n%s", out)
		}
		if strings.Contains(out, "SECRET_DELETED_BODY") {
			t.Errorf("deleted body leaked:\n%s", out)
		}
	})

	t.Run("empty-friendly", func(t *testing.T) {
		out, _ := renderDigest([]digestThread{}, false, false)
		if out != "No comments." {
			t.Errorf("got %q", out)
		}
	})

	t.Run("id-in-heading", func(t *testing.T) {
		threads := mustThreads(t, `[{"id":"t1","filePath":"index.md","quote":null,"status":"open","comments":[]}]`)
		out, _ := renderDigest(threads, false, false)
		if !strings.Contains(out, "### index.md · OPEN · t1") {
			t.Errorf("heading wrong:\n%s", out)
		}
	})

	t.Run("json-passthrough-preserves-all-server-fields", func(t *testing.T) {
		// Full ThreadView shape incl. fields the digest never reads. --json must NOT drop them.
		input := `[
			{"id":"a","filePath":"index.md","anchorType":"text","quote":"hello","anchorStatus":"anchored","start":0,"end":5,"status":"open","resolvedBy":null,"createdByName":"Ada","comments":[{"id":"c1","authorId":"u1","author":"Ada","body":"looks good","deleted":false,"editedAt":null}]},
			{"id":"b","filePath":"index.md","status":"resolved","quote":null,"comments":[]}
		]`
		threads := mustThreads(t, input)
		out, err := renderDigest(threads, false, true)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		var got, want any
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("output not valid JSON: %v\n%s", err, out)
		}
		if err := json.Unmarshal([]byte(input), &want); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("json passthrough dropped/changed fields\n got: %s\nwant: %s", out, input)
		}
	})
}
