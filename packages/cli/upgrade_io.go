package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"time"
)

// Self-update: download the latest release asset, verify its sha256, and rename(2) over the
// running binary. No staged "apply next run" step (darwin/linux only, where rename over a running
// executable is safe - the running process keeps its inode).

func statePath() string { return filepath.Join(configDir(), "update.json") }

func readState() UpdateState {
	data, err := os.ReadFile(statePath())
	if err != nil {
		return UpdateState{}
	}
	var s UpdateState
	if err := json.Unmarshal(data, &s); err != nil {
		return UpdateState{}
	}
	return s
}

// Update machinery must never break the CLI proper - state writes are best-effort.
func saveState(s UpdateState) {
	_ = os.MkdirAll(configDir(), 0o755)
	if data, err := json.Marshal(s); err == nil {
		_ = os.WriteFile(statePath(), data, 0o600)
	}
}

// Overridable so tests (and forks) can point at a fake release host.
func releaseBase() string {
	if v := strings.TrimSpace(os.Getenv("GLANCE_RELEASE_BASE")); v != "" {
		return v
	}
	return "https://github.com/plivo-labs/glance/releases"
}

// goAssetPlatform/goAssetArch map Go's runtime vocabulary onto the release asset vocabulary
// ('amd64' -> 'x64') that assetName + release.yml speak.
func goAssetPlatform() string { return runtime.GOOS }

func goAssetArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

// There is no interpreted mode in Go, but `go run`/an unstamped `go build` must never self-update.
// A released binary is stamped (version != the dev sentinel) and lives outside the build cache.
func isInstalledBinary() bool {
	if version == "0.0.0-dev" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return !strings.Contains(exe, string(filepath.Separator)+"go-build")
}

func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".glance-wtest-")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// `<base>/latest` resolves (via redirect) to `.../releases/tag/<tag>` - the tag rides in the final URL.
func fetchLatestTag(base string) (string, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", base+"/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent())
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	_ = resp.Body.Close()
	return parseLatestTag(resp.Request.URL.String()), nil
}

func getBytes(client *http.Client, url string) ([]byte, error) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return nil, fmt.Errorf("GET %s -> %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// Same contract as install.sh: gzipped binary + sha256 of the UNCOMPRESSED bytes. The verified
// binary is written next to the install target (same filesystem) then rename(2)d over it, so a
// crash or a concurrent updater can never leave a torn binary at the install path.
func downloadAndSwap(base, tag, execPath string) error {
	asset := assetName(goAssetPlatform(), goAssetArch())
	if asset == "" {
		return fmt.Errorf("unsupported platform: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	url := base + "/download/" + tag + "/" + asset
	client := &http.Client{Timeout: 120 * time.Second}

	gzBytes, err := getBytes(client, url+".gz")
	if err != nil {
		return fmt.Errorf("release %s is missing the %s asset", tag, asset)
	}
	sumBytes, err := getBytes(client, url+".sha256")
	if err != nil {
		return fmt.Errorf("release %s is missing the %s asset", tag, asset)
	}

	gr, err := gzip.NewReader(bytes.NewReader(gzBytes))
	if err != nil {
		return err
	}
	binary, err := io.ReadAll(gr)
	_ = gr.Close()
	if err != nil {
		return err
	}

	fields := strings.Fields(string(sumBytes))
	if len(fields) == 0 {
		return fmt.Errorf("checksum mismatch for %s (%s)", asset, tag)
	}
	sum := sha256.Sum256(binary)
	if hex.EncodeToString(sum[:]) != fields[0] {
		return fmt.Errorf("checksum mismatch for %s (%s)", asset, tag)
	}

	tmp := filepath.Join(filepath.Dir(execPath), fmt.Sprintf(".glance-update-%d", os.Getpid()))
	if err := os.WriteFile(tmp, binary, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil { // force exec bits past the umask
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, execPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// The new binary embeds a matching SKILL.md - refresh it so agent docs track the CLI. Best-effort.
func refreshSkill(execPath string) {
	cmd := exec.Command(execPath, "skill", "install")
	cmd.Stdout, cmd.Stderr = nil, nil
	_ = cmd.Start()
	if cmd.Process != nil {
		go func() { _ = cmd.Wait() }() // reap without blocking
	}
}

func (c *client) upgradeCmd(argv []string) error {
	background := slices.Contains(argv, "--quiet")
	if !isInstalledBinary() {
		if background {
			return nil
		}
		return fmt.Errorf("upgrade works on the installed standalone binary only (dev checkout: git pull)")
	}
	base := releaseBase()
	tag, err := fetchLatestTag(base)
	if err != nil || tag == "" {
		if background {
			return nil
		}
		return fmt.Errorf("upgrade failed: could not resolve the latest release")
	}
	latest := strings.TrimPrefix(tag, "v")
	if compareVersions(latest, version) <= 0 {
		if !background {
			fmt.Fprintf(c.out, "✓ glance %s is up to date.\n", version)
		}
		return nil
	}
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	if !dirWritable(dir) {
		if background {
			st := readState()
			st.Available = latest
			saveState(st)
			return nil
		}
		return fmt.Errorf("cannot write to %s — re-run the installer, or: sudo glance upgrade", dir)
	}
	if err := downloadAndSwap(base, tag, exe); err != nil {
		if background {
			return nil // background failures are silent by design - next TTL expiry retries
		}
		return fmt.Errorf("upgrade failed: %v", err)
	}
	refreshSkill(exe)
	if background {
		st := readState()
		st.UpdatedTo = latest
		st.Available = ""
		st.NotifiedAvailable = ""
		saveState(st)
	} else {
		fmt.Fprintf(c.out, "✓ Updated glance %s → %s\n", version, latest)
	}
	return nil
}

// Fire-and-forget: stamp the TTL, then hand off to a detached `upgrade --quiet` and return
// immediately - the user's command never waits on the network.
func maybeAutoUpdate() {
	if os.Getenv("GLANCE_NO_UPDATE") != "" || os.Getenv("CI") != "" {
		return
	}
	if !isInstalledBinary() {
		return
	}
	st := readState()
	now := time.Now().UnixMilli()
	if !shouldCheck(st, now) {
		return
	}
	st.LastCheckedAt = now
	saveState(st)
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(exe, "upgrade", "--quiet")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // detach from this process group
	if err := cmd.Start(); err == nil && cmd.Process != nil {
		_ = cmd.Process.Release()
	}
}

// One line on stderr - never stdout, which gets piped - the first run after a background swap, or
// once per version when an update exists but the install dir is read-only.
func (c *client) announceUpdate() {
	st := readState()
	msg, next, changed := planAnnouncement(st, version)
	if msg != "" {
		fmt.Fprintln(c.errOut, msg)
	}
	if changed {
		saveState(next)
	}
}
