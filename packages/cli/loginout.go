package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// login runs the device-code flow: start -> print URL + code -> open a browser -> poll until the
// user approves, then persist the token. Uses c.baseURL (set from apiBase() by main), and both the
// start and poll requests are UNauthenticated (there's no token yet).
func (c *client) login() error {
	api := c.baseURL
	req, _ := http.NewRequest("POST", api+"/api/auth/cli/start", nil)
	req.Header.Set("User-Agent", userAgent())
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	if !ok(resp) {
		resp.Body.Close()
		return fmt.Errorf("Could not start login (%d)", resp.StatusCode)
	}
	var start struct {
		DeviceCode      string `json:"deviceCode"`
		UserCode        string `json:"userCode"`
		VerificationURI string `json:"verificationUri"`
		Interval        int    `json:"interval"`
	}
	err = json.NewDecoder(resp.Body).Decode(&start)
	resp.Body.Close()
	if err != nil {
		return err
	}

	fmt.Fprintf(c.out, "\n  Open %s\n", start.VerificationURI)
	fmt.Fprintf(c.out, "  and approve code: %s\n\n", start.UserCode)
	c.openBrowser(start.VerificationURI)

	fmt.Fprint(c.out, "  Waiting for approval")
	for {
		wait := start.Interval
		if wait < 1 {
			wait = 1
		}
		c.sleep(time.Duration(wait) * time.Second)
		fmt.Fprint(c.out, ".")
		poll, err := c.http.Get(api + "/api/auth/cli/poll?device_code=" + encodeURIComponent(start.DeviceCode))
		if err != nil {
			return err
		}
		if poll.StatusCode == 404 {
			poll.Body.Close()
			return fmt.Errorf("\nLogin request expired. Try again.")
		}
		var data struct {
			Status      string `json:"status"`
			AccessToken string `json:"accessToken"`
		}
		err = json.NewDecoder(poll.Body).Decode(&data)
		poll.Body.Close()
		if err != nil {
			return err
		}
		if data.Status == "complete" && data.AccessToken != "" {
			if err := writeConfig(Config{ApiUrl: api, Token: data.AccessToken}); err != nil {
				return err
			}
			fmt.Fprintln(c.out, "\n✓ Logged in.")
			return nil
		}
	}
}

// logout revokes the server session (best-effort) and removes the local token.
func (c *client) logout() error {
	if c.token != "" {
		if resp, err := c.authed("POST", "/api/auth/logout", nil, nil); err == nil {
			resp.Body.Close()
		}
	}
	_ = os.Remove(configPath())
	fmt.Fprintln(c.out, "✓ Logged out.")
	return nil
}
