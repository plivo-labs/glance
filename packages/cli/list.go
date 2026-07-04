package main

import (
	"encoding/json"
	"fmt"
)

func (c *client) list() error {
	if err := c.requireAuth(); err != nil {
		return err
	}
	resp, err := c.authed("GET", "/api/sites/mine", nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Failed to list (%d)", resp.StatusCode)
	}
	var sites []struct {
		SiteSlug   string `json:"siteSlug"`
		SpaceSlug  string `json:"spaceSlug"`
		Visibility string `json:"visibility"`
		URL        string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sites); err != nil {
		return err
	}
	if len(sites) == 0 {
		fmt.Fprintln(c.out, "No sites yet.")
		return nil
	}
	for _, s := range sites {
		fmt.Fprintf(c.out, "  %-36s %-8s %s\n", s.SpaceSlug+"/"+s.SiteSlug, s.Visibility, s.URL)
	}
	return nil
}
