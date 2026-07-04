package main

import "testing"

func TestResolveReplyBody(t *testing.T) {
	t.Run("tag-default-agent-prefix", func(t *testing.T) {
		got, err := resolveReplyBody(strp("done"), nil, nil, false)
		if err != nil || got != "[agent] done" {
			t.Fatalf("got %q, err %v", got, err)
		}
	})

	t.Run("no-tag-plain", func(t *testing.T) {
		got, err := resolveReplyBody(strp("done"), nil, nil, true)
		if err != nil || got != "done" {
			t.Fatalf("got %q, err %v", got, err)
		}
	})

	t.Run("tag-custom-label", func(t *testing.T) {
		got, err := resolveReplyBody(strp("done"), nil, strp("claude"), false)
		if err != nil || got != "[claude] done" {
			t.Fatalf("got %q, err %v", got, err)
		}
	})

	t.Run("stdin-fallback-tagged", func(t *testing.T) {
		got, err := resolveReplyBody(nil, strp("from pipe"), nil, false)
		if err != nil || got != "[agent] from pipe" {
			t.Fatalf("got %q, err %v", got, err)
		}
	})

	t.Run("message-beats-stdin", func(t *testing.T) {
		got, err := resolveReplyBody(strp("from arg"), strp("from pipe"), nil, false)
		if err != nil || got != "[agent] from arg" {
			t.Fatalf("got %q, err %v", got, err)
		}
	})

	t.Run("empty-rejected-tag-cannot-rescue", func(t *testing.T) {
		for _, tc := range []struct {
			msg, stdin *string
			noTag      bool
		}{
			{strp("   "), nil, false},
			{nil, strp(""), false},
			{nil, strp("  \n "), false},
			{strp("  "), nil, true}, // even --no-tag can't validate an empty body
		} {
			if _, err := resolveReplyBody(tc.msg, tc.stdin, nil, tc.noTag); err == nil {
				t.Errorf("resolveReplyBody(%v) = no error, want error", tc)
			}
		}
	})

	t.Run("trims-outer-preserves-inner-newline", func(t *testing.T) {
		got, err := resolveReplyBody(strp("  line1\nline2  "), nil, nil, false)
		if err != nil || got != "[agent] line1\nline2" {
			t.Fatalf("got %q, err %v", got, err)
		}
	})
}
