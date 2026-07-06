package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// version is stamped at build time via `-ldflags "-X main.version=<tag>"`; the release workflow
// sets it from the git tag so a released CLI reports its exact version in the User-Agent.
var version = "0.0.0-dev"

// Sent on every authenticated request so the server can attribute CLI usage (and segment by
// version) in its analytics.
func userAgent() string { return "glance-cli/" + version }

// client carries the resolved instance URL + token plus the seams tests stub out (output sink,
// interactive input, sleep, browser opener). One command == one method on *client.
type client struct {
	baseURL     string
	token       string
	http        *http.Client
	out         io.Writer // stdout (results, piped output)
	errOut      io.Writer // stderr (warnings, update notices) - kept off stdout so pipes stay clean
	in          io.Reader // interactive prompt source (y/N confirmations)
	stdin       io.Reader // piped body source (reply)
	stdinIsTTY  bool
	openBrowser func(string)
	sleep       func(time.Duration)
}

func newClient(baseURL, token string, out io.Writer) *client {
	return &client{
		baseURL: baseURL,
		token:   token,
		// A timeout so a hung/slow server can't wedge a command forever. Per-request (each login
		// poll is its own request), and the self-updater builds its own longer-lived clients.
		http:        &http.Client{Timeout: 30 * time.Second},
		out:         out,
		errOut:      os.Stderr,
		in:          os.Stdin,
		stdin:       os.Stdin,
		stdinIsTTY:  isTTY(os.Stdin),
		openBrowser: openBrowser,
		sleep:       time.Sleep,
	}
}

// authed issues a request to the configured instance with the bearer token + User-Agent attached.
func (c *client) authed(method, path string, body io.Reader, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequest(method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", userAgent())
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return c.http.Do(req)
}

// requireAuth guards commands that need a saved token, matching the JS ordering: each command
// validates its args first, THEN calls this - so a usage error still beats "Not logged in".
func (c *client) requireAuth() error {
	if c.token == "" {
		return fmt.Errorf("Not logged in. Run `glance login` first.")
	}
	return nil
}

// ok mirrors the JS `Response.ok` (2xx) success gate.
func ok(resp *http.Response) bool { return resp.StatusCode >= 200 && resp.StatusCode < 300 }

// bodySlice reads a response body and truncates to 200 runes, for compact error surfacing.
func bodySlice(resp *http.Response) string {
	b, _ := io.ReadAll(resp.Body)
	r := []rune(string(b))
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}

// encodeURIComponent mirrors JS's function of the same name (unreserved set A-Za-z0-9 -_.!~*'(),
// space -> %20, UTF-8 bytes percent-encoded uppercase) - NOT url.QueryEscape (which uses '+').
func encodeURIComponent(s string) string {
	const keep = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if strings.IndexByte(keep, ch) >= 0 {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

func isTTY(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// Best-effort convenience only. On a headless box the opener is missing; a Start() error is
// swallowed (this is a device-code flow - the user can open the printed URL on any device).
func openBrowser(url string) {
	var name string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		name, args = "open", []string{url}
	case "windows":
		name, args = "cmd", []string{"/c", "start", url}
	default:
		name, args = "xdg-open", []string{url}
	}
	_ = exec.Command(name, args...).Start()
}
