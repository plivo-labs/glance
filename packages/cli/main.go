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
		cfg := readConfig()
		base, token := "", ""
		if cfg != nil {
			base, token = cfg.ApiUrl, cfg.Token
		}
		return newClient(base, token, os.Stdout).logout()
	case "deploy", "list", "delete", "move", "fork", "comments", "read", "reply", "notifications":
		// Authed commands resolve the instance from the STORED config (not the env override) - the
		// per-command requireAuth() inside each handler produces the clean "Not logged in" message.
		cfg := readConfig()
		base, token := "", ""
		if cfg != nil {
			base, token = cfg.ApiUrl, cfg.Token
		}
		c := newClient(base, token, os.Stdout)
		switch cmd {
		case "deploy":
			return c.deploy(rest)
		case "list":
			return c.list()
		case "delete":
			return c.del(rest)
		case "move":
			return c.move(rest)
		case "fork":
			return c.fork(rest)
		case "comments":
			return c.comments(rest)
		case "read":
			return c.read(rest)
		case "reply":
			return c.reply(rest)
		case "notifications":
			return c.notifications(rest)
		}
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
	fmt.Println("  glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|private|members]")
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
