package main

import (
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	if compareVersions("0.5.0", "0.4.9") <= 0 {
		t.Error("0.5.0 should be > 0.4.9")
	}
	if compareVersions("0.4.0", "0.4.0") != 0 {
		t.Error("equal versions should compare 0")
	}
	if compareVersions("0.4", "0.4.1") >= 0 {
		t.Error("0.4 should be < 0.4.1 (missing parts count as 0)")
	}
	if compareVersions("1.0.0", "0.99.99") <= 0 {
		t.Error("1.0.0 should be > 0.99.99 (numeric, not lexicographic)")
	}
	// a non-CLI release tag must never look like an upgrade target
	if compareVersions("ui-screens", "0.0.0") != 0 {
		t.Error("ui-screens vs 0.0.0 should be 0")
	}
	if compareVersions("ui-screens", "0.4.0") >= 0 {
		t.Error("ui-screens should never compare newer than 0.4.0")
	}
}

func TestParseLatestTag(t *testing.T) {
	cases := map[string]string{
		"https://github.com/plivo-labs/glance/releases/tag/v0.4.0":        "v0.4.0",
		"http://127.0.0.1:8080/releases/tag/v9.9.9?x=1#top":               "v9.9.9",
		"https://github.com/plivo-labs/glance/releases/tag/v0.4.0-rc%2B1": "v0.4.0-rc+1",
	}
	for url, want := range cases {
		if got := parseLatestTag(url); got != want {
			t.Errorf("parseLatestTag(%q) = %q, want %q", url, got, want)
		}
	}
	for _, url := range []string{
		"https://github.com/plivo-labs/glance/releases/latest",
		"https://github.com/plivo-labs/glance/releases/tag/",
	} {
		if got := parseLatestTag(url); got != "" {
			t.Errorf("parseLatestTag(%q) = %q, want empty", url, got)
		}
	}
}

func TestAssetName(t *testing.T) {
	if got := assetName("darwin", "arm64"); got != "glance-arm64-darwin" {
		t.Errorf("darwin/arm64 = %q", got)
	}
	if got := assetName("linux", "x64"); got != "glance-x64-linux" {
		t.Errorf("linux/x64 = %q", got)
	}
	if got := assetName("win32", "x64"); got != "" {
		t.Errorf("win32/x64 = %q, want empty", got)
	}
	if got := assetName("linux", "ia32"); got != "" {
		t.Errorf("linux/ia32 = %q, want empty", got)
	}
}

func TestShouldCheck(t *testing.T) {
	const day = int64(24 * 60 * 60 * 1000)
	if !shouldCheck(UpdateState{}, 1000) {
		t.Error("never-checked should return true")
	}
	if shouldCheck(UpdateState{LastCheckedAt: 1000}, 1000+day-1) {
		t.Error("within window should return false")
	}
	if !shouldCheck(UpdateState{LastCheckedAt: 1000}, 1000+day+1) {
		t.Error("expired window should return true")
	}
}

func TestPlanAnnouncement(t *testing.T) {
	t.Run("after-swap-announces-once", func(t *testing.T) {
		st := UpdateState{LastCheckedAt: 1, UpdatedTo: "0.5.0"}
		msg, next, changed := planAnnouncement(st, "0.5.0")
		if !strings.Contains(msg, "0.5.0") || !changed {
			t.Fatalf("msg=%q changed=%v", msg, changed)
		}
		if next.UpdatedTo != "" {
			t.Errorf("updatedTo not cleared: %q", next.UpdatedTo)
		}
		if next.LastCheckedAt != 1 {
			t.Errorf("unrelated state lost: %d", next.LastCheckedAt)
		}
		// cleared state announces nothing next run
		if msg2, _, _ := planAnnouncement(next, "0.5.0"); msg2 != "" {
			t.Errorf("re-announced: %q", msg2)
		}
	})

	t.Run("stale-swap-clears-silently", func(t *testing.T) {
		// a manual reinstall raced the background swap - never claim a version we're not running
		msg, next, changed := planAnnouncement(UpdateState{UpdatedTo: "0.5.0"}, "0.6.0")
		if msg != "" || !changed || next.UpdatedTo != "" {
			t.Fatalf("msg=%q changed=%v next=%+v", msg, changed, next)
		}
	})

	t.Run("available-nags-once-per-version", func(t *testing.T) {
		msg, next, _ := planAnnouncement(UpdateState{Available: "0.5.0"}, "0.4.0")
		if !strings.Contains(msg, "glance upgrade") {
			t.Fatalf("msg=%q", msg)
		}
		if next.NotifiedAvailable != "0.5.0" {
			t.Fatalf("notified=%q", next.NotifiedAvailable)
		}
		// same version -> silent
		if msg2, _, changed := planAnnouncement(next, "0.4.0"); msg2 != "" || changed {
			t.Errorf("re-nagged same version: msg=%q changed=%v", msg2, changed)
		}
		// newer available -> nags again
		bumped := next
		bumped.Available = "0.6.0"
		if msg3, _, _ := planAnnouncement(bumped, "0.4.0"); !strings.Contains(msg3, "0.6.0") {
			t.Errorf("did not nag for newer version: %q", msg3)
		}
	})

	t.Run("available-cleared-once-caught-up", func(t *testing.T) {
		msg, next, changed := planAnnouncement(UpdateState{Available: "0.5.0", NotifiedAvailable: "0.5.0"}, "0.5.0")
		if msg != "" || !changed {
			t.Fatalf("msg=%q changed=%v", msg, changed)
		}
		if next.Available != "" || next.NotifiedAvailable != "" {
			t.Errorf("not cleared: %+v", next)
		}
	})

	t.Run("noop-reports-unchanged", func(t *testing.T) {
		// callers skip the state write when nothing changed
		st := UpdateState{LastCheckedAt: 1}
		_, next, changed := planAnnouncement(st, "0.4.0")
		if changed || next != st {
			t.Errorf("changed=%v next=%+v", changed, next)
		}
	})
}
