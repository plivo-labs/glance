package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// cliOidc is what the server's /api/auth/cli/config hands the CLI: the provider and the public
// client to run its device flow with. TokenUse says which token the server accepts as a bearer.
type cliOidc struct {
	Issuer   string `json:"issuer"`
	ClientID string `json:"clientId"`
	Scope    string `json:"scope"`
	TokenUse string `json:"tokenUse"`
}

// OidcSession is the CLI's login when the instance signs in through its identity provider: a
// short-lived bearer plus the refresh token that renews it, so offboarding in the provider ends
// CLI access within the token lifetime instead of the 30 days of a Glance CLI token.
type OidcSession struct {
	ClientID      string `json:"clientId"`
	TokenEndpoint string `json:"tokenEndpoint"`
	// RevocationEndpoint is where logout revokes the refresh token (RFC 7009); empty when the
	// provider has none (Microsoft Entra ID).
	RevocationEndpoint string `json:"revocationEndpoint,omitempty"`
	Scope              string `json:"scope"`
	TokenUse           string `json:"tokenUse"`
	Bearer             string `json:"bearer"`
	RefreshToken       string `json:"refreshToken,omitempty"`
	ExpiresAt          int64  `json:"expiresAt"`
}

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"

// refreshMargin renews a token this long before it expires, so a request never carries one that
// dies on the way.
const refreshMargin = 60 * time.Second

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

// fetchCliOidc asks the instance whether it signs the CLI in through a provider. Anything but a
// 200 with a client id (404 on an instance without the feature, or an older server) means the
// classic Glance device flow.
func (c *client) fetchCliOidc() *cliOidc {
	resp, err := c.http.Get(c.baseURL + "/api/auth/cli/config")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return nil
	}
	var cfg cliOidc
	if json.NewDecoder(resp.Body).Decode(&cfg) != nil || cfg.Issuer == "" || cfg.ClientID == "" {
		return nil
	}
	return &cfg
}

func (c *client) postForm(endpoint string, form url.Values, out any) (int, error) {
	req, err := http.NewRequest("POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent())
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
}

// oidcLogin runs the provider's device authorization flow (RFC 8628) and persists the session.
func (c *client) oidcLogin(cfg *cliOidc) error {
	var disco struct {
		DeviceEndpoint     string `json:"device_authorization_endpoint"`
		TokenEndpoint      string `json:"token_endpoint"`
		RevocationEndpoint string `json:"revocation_endpoint"`
	}
	resp, err := c.http.Get(strings.TrimRight(cfg.Issuer, "/") + "/.well-known/openid-configuration")
	if err != nil {
		return err
	}
	err = json.NewDecoder(resp.Body).Decode(&disco)
	resp.Body.Close()
	if err != nil || disco.DeviceEndpoint == "" || disco.TokenEndpoint == "" {
		return fmt.Errorf("The sign-in provider does not offer the device flow")
	}

	var dev struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		CompleteURI     string `json:"verification_uri_complete"`
		Interval        int    `json:"interval"`
		ExpiresIn       int    `json:"expires_in"`
		Error           string `json:"error"`
	}
	form := url.Values{"client_id": {cfg.ClientID}, "scope": {cfg.Scope}}
	if status, err := c.postForm(disco.DeviceEndpoint, form, &dev); err != nil {
		return err
	} else if status < 200 || status >= 300 || dev.DeviceCode == "" {
		return fmt.Errorf("Could not start login (%d %s)", status, dev.Error)
	}

	open := dev.CompleteURI
	if open == "" {
		open = dev.VerificationURI
	}
	fmt.Fprintf(c.out, "\n  Open %s\n", open)
	fmt.Fprintf(c.out, "  and approve code: %s\n\n", dev.UserCode)
	c.openBrowser(open)

	interval := time.Duration(dev.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second // RFC 8628 default when the provider names none
	}
	deadline := time.Duration(dev.ExpiresIn) * time.Second
	fmt.Fprint(c.out, "  Waiting for approval")
	for waited := time.Duration(0); deadline == 0 || waited <= deadline; waited += interval {
		c.sleep(interval)
		fmt.Fprint(c.out, ".")
		var tok tokenResponse
		form := url.Values{"grant_type": {deviceGrant}, "client_id": {cfg.ClientID}, "device_code": {dev.DeviceCode}}
		if _, err := c.postForm(disco.TokenEndpoint, form, &tok); err != nil {
			return err
		}
		switch tok.Error {
		case "":
			session, err := newOidcSession(cfg, disco.TokenEndpoint, tok)
			if err != nil {
				return err
			}
			session.RevocationEndpoint = disco.RevocationEndpoint
			if err := writeConfig(Config{ApiUrl: c.baseURL, Oidc: session}); err != nil {
				return err
			}
			fmt.Fprintln(c.out, "\n✓ Logged in.")
			return nil
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return fmt.Errorf("\nLogin was denied.")
		default:
			return fmt.Errorf("\nLogin failed: %s %s", tok.Error, tok.ErrorDesc)
		}
	}
	return fmt.Errorf("\nLogin request expired. Try again.")
}

func newOidcSession(cfg *cliOidc, tokenEndpoint string, tok tokenResponse) (*OidcSession, error) {
	bearer := tok.IDToken
	if cfg.TokenUse == "access" {
		bearer = tok.AccessToken
	}
	if bearer == "" {
		return nil, fmt.Errorf("The provider returned no %s token (is the scope %q right?)", cfg.TokenUse, cfg.Scope)
	}
	return &OidcSession{
		ClientID:      cfg.ClientID,
		TokenEndpoint: tokenEndpoint,
		Scope:         cfg.Scope,
		TokenUse:      cfg.TokenUse,
		Bearer:        bearer,
		RefreshToken:  tok.RefreshToken,
		ExpiresAt:     jwtExpiry(bearer),
	}, nil
}

// jwtExpiry reads `exp` from a JWT without verifying it (the server does that); 0 when unreadable,
// which makes the CLI refresh on every use rather than send a token it cannot date.
func jwtExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return 0
	}
	return claims.Exp
}

// oidcBearer is the bearer for a stored provider session, renewed with the refresh token when it is
// about to expire. A failed renewal keeps the old token: a network blip must not log anyone out, and
// a revoked refresh token shows up as the server's 401 on the next request.
func oidcBearer(s *OidcSession, now time.Time, save func(*OidcSession)) string {
	if now.Add(refreshMargin).Unix() < s.ExpiresAt || s.RefreshToken == "" {
		return s.Bearer
	}
	c := newClient("", "", os.Stderr)
	var tok tokenResponse
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {s.RefreshToken},
		"client_id":     {s.ClientID},
		"scope":         {s.Scope},
	}
	if status, err := c.postForm(s.TokenEndpoint, form, &tok); err != nil || status < 200 || status >= 300 || tok.Error != "" {
		return s.Bearer
	}
	renewed, err := newOidcSession(&cliOidc{ClientID: s.ClientID, Scope: s.Scope, TokenUse: s.TokenUse}, s.TokenEndpoint, tok)
	if err != nil {
		return s.Bearer
	}
	if renewed.RefreshToken == "" {
		renewed.RefreshToken = s.RefreshToken // the provider does not rotate refresh tokens
	}
	renewed.RevocationEndpoint = s.RevocationEndpoint
	save(renewed)
	return renewed.Bearer
}

// oidcLogout ends a provider session: it revokes the refresh token at the provider (RFC 7009), so
// the login cannot be renewed from a copy of config.json, then removes the local session. The
// current bearer stays valid until it expires (an hour at most); a provider without a revocation
// endpoint leaves the refresh token valid too, and the CLI says so.
func (c *client) oidcLogout(s *OidcSession) error {
	revoked := s.RefreshToken == ""
	if !revoked && s.RevocationEndpoint != "" {
		form := url.Values{"token": {s.RefreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {s.ClientID}}
		var ignored struct{}
		status, _ := c.postForm(s.RevocationEndpoint, form, &ignored) // the 200 has no body to decode
		revoked = status >= 200 && status < 300
	}
	_ = os.Remove(configPath())
	if !revoked {
		fmt.Fprintln(c.errOut, "warning: the sign-in provider did not revoke this login; it is removed from this machine only and stays valid at the provider until it expires.")
	}
	fmt.Fprintln(c.out, "✓ Logged out.")
	return nil
}
