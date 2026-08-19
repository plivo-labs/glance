package main

import (
	"fmt"
	"os"
)

// Glance CLI - deploy folders to Glance from the terminal.
func main() {
	args := os.Args[1:]
	raw := ""
	if len(args) > 0 {
		raw = args[0]
	}
	cmd := raw
	if raw == "--version" {
		cmd = "version"
	}
	var rest []string
	if len(args) > 1 {
		rest = args[1:]
	}

	// Self-update hooks, skipped for machine-invoked commands: `upgrade` IS the updater, and `skill`
	// is run by install.sh and by the post-swap refresh child - which would otherwise consume the
	// pending "auto-updated" notice before the user ever sees it.
	if cmd != "upgrade" && cmd != "skill" {
		newClient("", "", os.Stdout).announceUpdate()
		maybeAutoUpdate()
	}

	if err := dispatch(cmd, rest); err != nil {
		fmt.Fprintln(os.Stderr, "✗ "+err.Error())
		os.Exit(1)
	}
}

var authedCmds = map[string]func(*client, []string) error{
	"deploy":        (*client).deploy,
	"list":          func(c *client, _ []string) error { return c.list() },
	"delete":        (*client).del,
	"move":          (*client).move,
	"fork":          (*client).fork,
	"comments":      (*client).comments,
	"read":          (*client).read,
	"reply":         (*client).reply,
	"notifications": (*client).notifications,
}

func dispatch(cmd string, rest []string) error {
	switch cmd {
	case "login":
		return newClient(apiBase(), "", os.Stdout).login()
	case "version":
		fmt.Println(version)
		return nil
	case "upgrade":
		return newClient("", "", os.Stdout).upgradeCmd(rest)
	case "skill":
		return newClient("", "", os.Stdout).skillCmd(rest)
	case "logout":
		// Deliberately NOT apiToken(): logout is a session verb and must act on the credential
		// `glance login` stored. Letting GLANCE_TOKEN shadow it means an exported API key gets
		// POSTed to /api/auth/logout, which answers 400 (a key is revoked from the keys screen,
		// not by logging out) — and logout then still removes config.json, so the user's real
		// session token would be gone locally while staying valid server-side.
		cfg := readConfig()
		base, token := "", ""
		if cfg != nil {
			base, token = cfg.ApiUrl, cfg.Token
		}
		return newClient(base, token, os.Stdout).logout()
	}
	if run, found := authedCmds[cmd]; found {
		// Both halves of the credential come from the same precedence: env override, then stored
		// config. Resolving the token from the env but the URL from disk only would half-wire it —
		// a CI container with GLANCE_TOKEN and GLANCE_API_URL exported but no ~/.glance/config.json
		// (a baked-in binary, no installer run) would pass requireAuth() on the non-empty token and
		// then fail every request with `unsupported protocol scheme ""`. apiBase()'s local-dev
		// fallback keeps the clean "Not logged in" path intact when neither is set: the base is
		// non-empty, the token is not, and requireAuth() catches it.
		return run(newClient(apiBase(), apiToken(), os.Stdout), rest)
	}
	printHelp()
	if cmd != "" {
		os.Exit(1)
	}
	os.Exit(0)
	return nil
}

func printHelp() {
	fmt.Println("glance — deploy folders to Glance")
	fmt.Println()
	fmt.Println("  glance login")
	fmt.Println("  glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|private|members] [--theme <slug>|default]")
	fmt.Println("  glance list")
	fmt.Println("  glance delete <space/slug>")
	fmt.Println("  glance move <space/slug> <new-space>")
	fmt.Println("  glance fork <space/slug> [--space <slug>] [--name <slug>]")
	fmt.Println("  glance comments <space/slug> [--file <path>] [--open] [--json]")
	fmt.Println("  glance reply <space/slug> <threadId> [message] [--tag <label> | --no-tag]")
	fmt.Println("  glance read <space/slug> [--file <path>] [--pull <dir>]")
	fmt.Println("  glance notifications [--read] [--json]")
	fmt.Println("  glance skill install")
	fmt.Println("  glance upgrade")
	fmt.Println("  glance version")
	fmt.Println("  glance logout")
}
