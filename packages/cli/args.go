package main

// Parse `--flag value` pairs and positionals. Flags named in booleanFlags are valueless
// (`--open` -> true) and do NOT consume the next token, so a positional after them survives
// (e.g. `comments --open x/y` keeps `x/y`). Every other flag is a value-flag (string); a
// trailing value-flag with no token yields "" (mirrors JS `argv[++i] ?? ”`). A bare `--`
// stops flag parsing: everything after it is positional (dash-leading values survive).
func parseArgs(argv []string, booleanFlags map[string]bool) (positional []string, flags map[string]any) {
	positional = []string{}
	flags = map[string]any{}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if a == "--" {
			positional = append(positional, argv[i+1:]...)
			break
		}
		if len(a) >= 2 && a[:2] == "--" {
			key := a[2:]
			if booleanFlags[key] {
				flags[key] = true
			} else if i+1 < len(argv) {
				i++
				flags[key] = argv[i]
			} else {
				flags[key] = ""
			}
		} else {
			positional = append(positional, a)
		}
	}
	return positional, flags
}
