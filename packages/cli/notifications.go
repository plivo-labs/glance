package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

type notificationItem struct {
	Type      string  `json:"type"` // "mention" | "comment"
	ActorName *string `json:"actorName"`
	SiteLabel *string `json:"siteLabel"`
	FilePath  *string `json:"filePath"`
	Snippet   *string `json:"snippet"`
	Read      bool    `json:"read"`
	CreatedAt string  `json:"createdAt"`
}

type notificationsResponse struct {
	Items       []notificationItem `json:"items"`
	UnreadCount int                `json:"unreadCount"`
}

func (c *client) notifications(args []string) error {
	_, flags := parseArgs(args, boolSet("json", "read"))
	if flags["read"] == true && flags["json"] == true {
		return fmt.Errorf("--read and --json cannot be combined")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	if flags["read"] == true {
		return c.markNotificationsRead()
	}

	resp, err := c.authed("GET", "/api/notifications", nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Failed to fetch notifications (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	if flags["json"] == true {
		_, err := io.Copy(c.out, resp.Body)
		return err
	}

	var data notificationsResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return err
	}
	if len(data.Items) == 0 {
		fmt.Fprintln(c.out, "No notifications.")
		return nil
	}
	fmt.Fprintf(c.out, "%d unread · %d shown\n", data.UnreadCount, len(data.Items))
	now := time.Now()
	for _, item := range data.Items {
		fmt.Fprint(c.out, renderNotification(item, now))
	}
	return nil
}

func (c *client) markNotificationsRead() error {
	resp, err := c.authed("POST", "/api/notifications/read", strings.NewReader("{}"),
		map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Failed to mark notifications read (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	fmt.Fprintln(c.out, "✓ Marked all notifications read")
	return nil
}

// strOr returns *p when non-nil and non-empty, else fallback.
func strOr(p *string, fallback string) string {
	if p != nil && *p != "" {
		return *p
	}
	return fallback
}

func renderNotification(item notificationItem, now time.Time) string {
	marker := "✓"
	if !item.Read {
		marker = "●"
	}
	verb := "commented on"
	if item.Type == "mention" {
		verb = "mentioned you on"
	}
	paren := timeAgo(item.CreatedAt, now)
	if fp := strOr(item.FilePath, ""); fp != "" {
		paren = fp + ", " + paren
	}
	s := fmt.Sprintf("%s %s %s %s (%s)\n",
		marker, strOr(item.ActorName, "Someone"), verb, strOr(item.SiteLabel, "a site"), paren)
	if snip := strOr(item.Snippet, ""); snip != "" {
		s += fmt.Sprintf("  “%s”\n", snip)
	}
	return s
}

// timeAgo formats createdAt as a short relative string. Unknown/unparseable times fall back to
// the raw value so a bad timestamp never blanks the line.
func timeAgo(createdAt string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		return createdAt
	}
	d := now.Sub(t)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
