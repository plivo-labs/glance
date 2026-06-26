#!/bin/sh
set -eu

REPO="samuellawerentz/glance"
INSTALL_DIR="${GLANCE_INSTALL_DIR:-$HOME/.local/bin}"

main() {
    platform="$(detect_platform)"
    arch="$(detect_arch)"
    artifact="glance-${arch}-${platform}"

    version="$(latest_version)"
    if [ -z "$version" ]; then
        err "could not determine latest version — has a release been published?"
    fi
    say "Installing glance $version ($arch-$platform)"

    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' EXIT

    url="https://github.com/${REPO}/releases/download/${version}/${artifact}"
    say "Downloading $url"
    download "$url" "$tmpdir/glance"
    download "${url}.sha256" "$tmpdir/glance.sha256"
    verify_checksum "$tmpdir/glance" "$tmpdir/glance.sha256"

    mkdir -p "$INSTALL_DIR"
    mv "$tmpdir/glance" "$INSTALL_DIR/glance"
    chmod +x "$INSTALL_DIR/glance"
    say "Installed glance to $INSTALL_DIR/glance"

    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        warn "$INSTALL_DIR is not in your PATH"
        add_to_path "$INSTALL_DIR"
    fi

    if [ -n "${GLANCE_API_URL:-}" ]; then
        persist_api_url "$GLANCE_API_URL"
    fi

    install_skill

    say ""
    say "Done! Run 'glance login' to get started."
}

# Best-effort: if npx is available, install the glance-cli skill so AI agents
# (Claude Code, Codex, Cursor, …) know how to drive the CLI. Never fatal — the
# binary install above is what matters; a skill hiccup must not abort it.
install_skill() {
    command -v npx > /dev/null 2>&1 || return 0
    say "Installing the glance skill for AI agents (npx skills)"
    if npx --yes skills add "$REPO" --global --yes > /dev/null 2>&1; then
        say "Skill installed for your AI agents"
    else
        warn "Skill install skipped — CLI is unaffected (run: npx skills add $REPO)"
    fi
}

detect_platform() {
    case "$(uname -s)" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "darwin" ;;
        *)       err "unsupported platform: $(uname -s)" ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        aarch64|arm64) echo "arm64" ;;
        *)             err "unsupported architecture: $(uname -m)" ;;
    esac
}

latest_version() {
    if command -v curl > /dev/null 2>&1; then
        curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
            | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'
    elif command -v wget > /dev/null 2>&1; then
        wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
            | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'
    else
        err "curl or wget is required"
    fi
}

download() {
    if command -v curl > /dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    elif command -v wget > /dev/null 2>&1; then
        wget -qO "$2" "$1"
    else
        err "curl or wget is required"
    fi
}

verify_checksum() {
    file="$1"
    checksum_file="$2"
    say "Verifying checksum"
    expected="$(awk '{print $1}' "$checksum_file")"
    if command -v sha256sum > /dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum > /dev/null 2>&1; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        err "sha256sum or shasum is required for checksum verification"
    fi
    if [ "$actual" != "$expected" ]; then
        err "checksum mismatch — download may be corrupt or tampered with
    expected: $expected
    actual:   $actual"
    fi
    say "Checksum verified"
}

detect_profile() {
    if [ -n "${ZSH_VERSION:-}" ] || [ -f "$HOME/.zshrc" ]; then
        echo "$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
        echo "$HOME/.bashrc"
    elif [ -f "$HOME/.profile" ]; then
        echo "$HOME/.profile"
    fi
}

add_to_path() {
    dir="$1"
    profile="$(detect_profile)"
    if [ -n "$profile" ]; then
        if ! grep -qF "$dir" "$profile" 2>/dev/null; then
            echo "" >> "$profile"
            echo "# Added by glance installer" >> "$profile"
            echo "export PATH=\"${dir}:\$PATH\"" >> "$profile"
            say "Added $dir to PATH in $profile — restart your shell or run: source $profile"
        fi
    else
        say "Add this to your shell profile: export PATH=\"${dir}:\$PATH\""
    fi
}

persist_api_url() {
    url="$1"
    profile="$(detect_profile)"
    if [ -n "$profile" ]; then
        if grep -q "export GLANCE_API_URL=" "$profile" 2>/dev/null; then
            warn "GLANCE_API_URL already set in $profile — leaving it as-is"
        else
            echo "" >> "$profile"
            echo "# Added by glance installer" >> "$profile"
            echo "export GLANCE_API_URL=\"${url}\"" >> "$profile"
            say "Set GLANCE_API_URL=$url in $profile — restart your shell or run: source $profile"
        fi
    else
        say "Add this to your shell profile: export GLANCE_API_URL=\"${url}\""
    fi
}

say()  { printf "  \033[1;32mglance\033[0m: %s\n" "$*"; }
warn() { printf "  \033[1;33mglance\033[0m: %s\n" "$*"; }
err()  { printf "  \033[1;31mglance\033[0m: %s\n" "$*" >&2; exit 1; }

main
