package main

import "testing"

func strp(s string) *string { return &s }

func TestParseReplyArgs(t *testing.T) {
	t.Run("happy-space-slug-thread-message", func(t *testing.T) {
		got, err := parseReplyArgs([]string{"acme/doc", "t1", "fixed it"})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got.space != "acme" || got.site != "doc" || got.threadID != "t1" {
			t.Fatalf("got = %+v", got)
		}
		if got.message == nil || *got.message != "fixed it" {
			t.Fatalf("message = %v", got.message)
		}
		if got.tag != nil || got.noTag {
			t.Fatalf("unexpected tag/noTag: %+v", got)
		}
	})

	t.Run("message-optional-stdin-path", func(t *testing.T) {
		got, err := parseReplyArgs([]string{"acme/doc", "t1"})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got.message != nil {
			t.Fatalf("message should be nil (stdin path), got %v", *got.message)
		}
	})

	t.Run("malformed-slug-errors", func(t *testing.T) {
		for _, argv := range [][]string{
			{"acme", "t1", "x"},
			{"acme/", "t1", "x"},
			{"/doc", "t1", "x"},
			{"a/b/c", "t1", "x"},
		} {
			if _, err := parseReplyArgs(argv); err == nil {
				t.Errorf("parseReplyArgs(%v) = no error, want error", argv)
			}
		}
	})

	t.Run("missing-threadId-errors", func(t *testing.T) {
		if _, err := parseReplyArgs([]string{"acme/doc"}); err == nil {
			t.Fatal("want error for missing threadId")
		}
	})

	t.Run("dash-sentinel-literal-message", func(t *testing.T) {
		got, err := parseReplyArgs([]string{"acme/doc", "t1", "--", "--fix the thing"})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got.message == nil || *got.message != "--fix the thing" {
			t.Fatalf("message = %v", got.message)
		}
	})

	t.Run("tag-and-no-tag-conflict-errors", func(t *testing.T) {
		if _, err := parseReplyArgs([]string{"acme/doc", "t1", "msg", "--tag", "x", "--no-tag"}); err == nil {
			t.Fatal("want error for --tag + --no-tag")
		}
	})

	t.Run("blank-tag-errors", func(t *testing.T) {
		if _, err := parseReplyArgs([]string{"acme/doc", "t1", "msg", "--tag"}); err == nil {
			t.Fatal("want error for trailing --tag")
		}
	})

	t.Run("tag-value-carried", func(t *testing.T) {
		got, err := parseReplyArgs([]string{"acme/doc", "t1", "msg", "--tag", "claude"})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got.tag == nil || *got.tag != "claude" {
			t.Fatalf("tag = %v", got.tag)
		}
	})

	t.Run("no-tag-carried", func(t *testing.T) {
		got, err := parseReplyArgs([]string{"acme/doc", "t1", "msg", "--no-tag"})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if !got.noTag {
			t.Fatal("noTag = false, want true")
		}
	})
}
