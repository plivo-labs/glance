package main

import (
	"reflect"
	"testing"
)

func TestParseArgs(t *testing.T) {
	// boolean flags are valueless and must NOT eat the next token
	t.Run("boolean-flag-not-eat-token", func(t *testing.T) {
		pos, flags := parseArgs([]string{"x/y", "--open", "--json"}, boolSet("open", "json"))
		if flags["open"] != true || flags["json"] != true {
			t.Fatalf("bool flags = %v", flags)
		}
		if !reflect.DeepEqual(pos, []string{"x/y"}) {
			t.Fatalf("positional = %v", pos)
		}
	})

	// value flags still consume the following token
	t.Run("value-flags-still-consume", func(t *testing.T) {
		pos, flags := parseArgs([]string{"--space", "docs", "--name", "r"}, nil)
		if flags["space"] != "docs" || flags["name"] != "r" {
			t.Fatalf("value flags = %v", flags)
		}
		if len(pos) != 0 {
			t.Fatalf("positional = %v, want empty", pos)
		}
	})

	// a positional after a boolean flag survives
	t.Run("boolean-then-positional", func(t *testing.T) {
		pos, flags := parseArgs([]string{"--open", "x/y"}, boolSet("open", "json"))
		if !reflect.DeepEqual(pos, []string{"x/y"}) {
			t.Fatalf("positional = %v", pos)
		}
		if flags["open"] != true {
			t.Fatalf("open = %v", flags["open"])
		}
	})

	// trailing value flag with no token -> empty string (mirrors JS `argv[++i] ?? ''`)
	t.Run("trailing-value-flag-empty", func(t *testing.T) {
		_, flags := parseArgs([]string{"--file"}, nil)
		if flags["file"] != "" {
			t.Fatalf("file = %v, want empty string", flags["file"])
		}
	})
}
