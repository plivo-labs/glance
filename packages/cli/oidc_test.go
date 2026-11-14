package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fakeJWT(exp int64) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	return enc(map[string]string{"alg": "RS256"}) + "." + enc(map[string]any{"exp": exp}) + ".sig"
}

// fakeProvider is an identity provider with the device flow plus a Glance instance that points at it.
type fakeProvider struct {
	srv          *httptest.Server
	tokenForms   []url.Values
	pending      int32 // device polls to answer "authorization_pending" first
	deviceError  string
	idToken      string
	refreshToken string
	refreshedID  string
}

func newFakeProvider(t *testing.T, tokenUse string) *fakeProvider {
	p := &fakeProvider{pending: 1, idToken: fakeJWT(time.Now().Add(time.Hour).Unix()), refreshToken: "RT-1"}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/cli/config": // the Glance instance
			fmt.Fprintf(w, `{"issuer":%q,"clientId":"cli-client","scope":"openid offline_access","tokenUse":%q}`, p.srv.URL, tokenUse)
		case "/.well-known/openid-configuration":
			fmt.Fprintf(w, `{"device_authorization_endpoint":"%s/device","token_endpoint":"%s/token","revocation_endpoint":"%s/revoke"}`, p.srv.URL, p.srv.URL, p.srv.URL)
		case "/device":
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), "client_id=cli-client") || !strings.Contains(string(body), "scope=openid+offline_access") {
				t.Errorf("device request = %s", body)
			}
			io.WriteString(w, `{"device_code":"DC","user_code":"ABCD-EFGH","verification_uri":"https://verify","verification_uri_complete":"https://verify?code=ABCD-EFGH","interval":1,"expires_in":600}`)
		case "/token":
			r.ParseForm()
			p.tokenForms = append(p.tokenForms, r.PostForm)
			switch r.PostForm.Get("grant_type") {
			case deviceGrant:
				if p.deviceError != "" {
					w.WriteHeader(400)
					fmt.Fprintf(w, `{"error":%q}`, p.deviceError)
				} else if atomic.AddInt32(&p.pending, -1) >= 0 {
					w.WriteHeader(400)
					io.WriteString(w, `{"error":"authorization_pending"}`)
				} else {
					fmt.Fprintf(w, `{"access_token":"AT-1","id_token":%q,"refresh_token":%q,"expires_in":3600}`, p.idToken, p.refreshToken)
				}
			case "refresh_token":
				fmt.Fprintf(w, `{"access_token":"AT-2","id_token":%q}`, p.refreshedID)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func TestOidcLogin(t *testing.T) {
	t.Run("device-flow-stores-the-id-token-and-refresh-token", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		p := newFakeProvider(t, "id")
		c, out := newTestClient(p.srv.URL, "")
		if err := c.login(); err != nil {
			t.Fatalf("login: %v", err)
		}
		if !strings.Contains(out.String(), "ABCD-EFGH") || !strings.Contains(out.String(), "Logged in") {
			t.Fatalf("out = %q", out.String())
		}
		cfg := readConfig()
		if cfg == nil || cfg.Oidc == nil || cfg.Token != "" {
			t.Fatalf("config = %+v", cfg)
		}
		if cfg.Oidc.Bearer != p.idToken || cfg.Oidc.RefreshToken != "RT-1" || cfg.Oidc.ClientID != "cli-client" {
			t.Fatalf("session = %+v", cfg.Oidc)
		}
		if cfg.Oidc.RevocationEndpoint != p.srv.URL+"/revoke" {
			t.Fatalf("revocation endpoint = %q", cfg.Oidc.RevocationEndpoint)
		}
		if cfg.Oidc.ExpiresAt != jwtExpiry(p.idToken) || cfg.Oidc.ExpiresAt == 0 {
			t.Fatalf("expiry = %d", cfg.Oidc.ExpiresAt)
		}
		if len(p.tokenForms) != 2 {
			t.Fatalf("expected one pending poll then success, got %d polls", len(p.tokenForms))
		}
	})

	t.Run("access-token-instances-store-the-access-token", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		p := newFakeProvider(t, "access")
		c, _ := newTestClient(p.srv.URL, "")
		if err := c.login(); err != nil {
			t.Fatalf("login: %v", err)
		}
		if got := readConfig().Oidc.Bearer; got != "AT-1" {
			t.Fatalf("bearer = %q", got)
		}
	})

	t.Run("denied-and-failed-logins-error-without-saving", func(t *testing.T) {
		for _, tc := range []struct{ code, want string }{{"access_denied", "denied"}, {"invalid_client", "invalid_client"}} {
			t.Setenv("HOME", t.TempDir())
			p := newFakeProvider(t, "id")
			p.deviceError = tc.code
			c, _ := newTestClient(p.srv.URL, "")
			err := c.login()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("%s: err = %v", tc.code, err)
			}
			if readConfig() != nil {
				t.Fatalf("%s: a failed login must not write a config", tc.code)
			}
		}
	})

	t.Run("an-instance-without-the-feature-keeps-the-classic-flow", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/auth/cli/start":
				io.WriteString(w, `{"deviceCode":"DC","userCode":"WXYZ","verificationUri":"https://verify","interval":0}`)
			case "/api/auth/cli/poll":
				io.WriteString(w, `{"status":"complete","accessToken":"AT-classic"}`)
			default:
				w.WriteHeader(404)
			}
		}))
		defer srv.Close()
		c, _ := newTestClient(srv.URL, "")
		if err := c.login(); err != nil {
			t.Fatalf("login: %v", err)
		}
		if cfg := readConfig(); cfg.Token != "AT-classic" || cfg.Oidc != nil {
			t.Fatalf("config = %+v", cfg)
		}
	})
}

func TestOidcBearer(t *testing.T) {
	now := time.Now()
	saved := (*OidcSession)(nil)
	save := func(s *OidcSession) { saved = s }

	t.Run("a-fresh-token-is-used-as-is", func(t *testing.T) {
		p := newFakeProvider(t, "id")
		s := &OidcSession{ClientID: "cli-client", TokenEndpoint: p.srv.URL + "/token", Bearer: "B1", RefreshToken: "RT-1", ExpiresAt: now.Add(time.Hour).Unix()}
		if got := oidcBearer(s, now, save); got != "B1" || len(p.tokenForms) != 0 {
			t.Fatalf("bearer = %q, refreshes = %d", got, len(p.tokenForms))
		}
	})

	t.Run("an-expiring-token-is-refreshed-and-saved-keeping-the-refresh-token", func(t *testing.T) {
		p := newFakeProvider(t, "id")
		p.refreshedID = fakeJWT(now.Add(time.Hour).Unix())
		s := &OidcSession{ClientID: "cli-client", TokenEndpoint: p.srv.URL + "/token", Scope: "openid", TokenUse: "id", Bearer: "OLD", RefreshToken: "RT-1", ExpiresAt: now.Add(10 * time.Second).Unix()}
		got := oidcBearer(s, now, save)
		if got != p.refreshedID || saved == nil || saved.Bearer != p.refreshedID || saved.RefreshToken != "RT-1" {
			t.Fatalf("bearer = %q, saved = %+v", got, saved)
		}
		if f := p.tokenForms[0]; f.Get("refresh_token") != "RT-1" || f.Get("client_id") != "cli-client" {
			t.Fatalf("refresh form = %v", f)
		}
	})

	t.Run("a-failed-refresh-keeps-the-old-token", func(t *testing.T) {
		saved = nil
		s := &OidcSession{ClientID: "c", TokenEndpoint: "http://127.0.0.1:1/token", Bearer: "OLD", RefreshToken: "RT", ExpiresAt: now.Add(-time.Hour).Unix()}
		if got := oidcBearer(s, now, save); got != "OLD" || saved != nil {
			t.Fatalf("bearer = %q, saved = %+v", got, saved)
		}
	})

	t.Run("an-unreadable-expiry-refreshes-every-time", func(t *testing.T) {
		if jwtExpiry("not-a-jwt") != 0 || jwtExpiry("a.b.c") != 0 {
			t.Fatal("garbage must read as 0")
		}
	})
}

func TestApiTokenUsesTheOidcSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GLANCE_TOKEN", "")
	p := newFakeProvider(t, "id")
	p.refreshedID = fakeJWT(time.Now().Add(time.Hour).Unix())
	stale := &OidcSession{ClientID: "cli-client", TokenEndpoint: p.srv.URL + "/token", Scope: "openid", TokenUse: "id", Bearer: "OLD", RefreshToken: "RT-1", ExpiresAt: time.Now().Add(-time.Minute).Unix()}
	if err := writeConfig(Config{ApiUrl: "https://glance.example.com", Oidc: stale}); err != nil {
		t.Fatal(err)
	}

	if got := apiToken(); got != p.refreshedID {
		t.Fatalf("apiToken = %q, want the refreshed token", got)
	}
	if cfg := readConfig(); cfg.Oidc.Bearer != p.refreshedID || cfg.ApiUrl != "https://glance.example.com" {
		t.Fatalf("the renewed session must be saved with the instance url: %+v", cfg)
	}
	t.Setenv("GLANCE_TOKEN", "glk_override")
	if got := apiToken(); got != "glk_override" {
		t.Fatalf("an exported token still wins, got %q", got)
	}
}

func TestOidcLogout(t *testing.T) {
	session := func(revocation string) *OidcSession {
		return &OidcSession{ClientID: "cli-client", RevocationEndpoint: revocation, Bearer: "B", RefreshToken: "RT-1"}
	}
	run := func(t *testing.T, s *OidcSession) string {
		t.Setenv("HOME", t.TempDir())
		if err := writeConfig(Config{ApiUrl: "https://glance.example.com", Oidc: s}); err != nil {
			t.Fatal(err)
		}
		c, _ := newTestClient("https://glance.example.com", "")
		var warnings bytes.Buffer
		c.errOut = &warnings
		if err := c.oidcLogout(s); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(configPath()); !os.IsNotExist(err) {
			t.Fatalf("the local session must be removed, stat err = %v", err)
		}
		return warnings.String()
	}

	t.Run("revokes-the-refresh-token-at-the-provider", func(t *testing.T) {
		var form url.Values
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.ParseForm()
			form = r.PostForm
		}))
		defer srv.Close()
		if warned := run(t, session(srv.URL+"/revoke")); warned != "" {
			t.Fatalf("unexpected warning: %q", warned)
		}
		if form.Get("token") != "RT-1" || form.Get("token_type_hint") != "refresh_token" || form.Get("client_id") != "cli-client" {
			t.Fatalf("revocation form = %v", form)
		}
	})

	t.Run("says-so-when-the-provider-cannot-revoke", func(t *testing.T) {
		if warned := run(t, session("")); !strings.Contains(warned, "this machine only") {
			t.Fatalf("warning = %q", warned)
		}
	})

	t.Run("says-so-when-the-revocation-fails", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
		defer srv.Close()
		if warned := run(t, session(srv.URL+"/revoke")); !strings.Contains(warned, "this machine only") {
			t.Fatalf("warning = %q", warned)
		}
	})
}
