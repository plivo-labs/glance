package main

import (
	"strings"
	"testing"
)

func TestArchiveCommands(t *testing.T) {
	for _, tc := range []struct {
		run       func(c *client, argv []string) error
		body, out string
	}{
		{(*client).archive, `{"archived":true}`, "Archived docs/api"},
		{(*client).unarchive, `{"archived":false}`, "Unarchived docs/api"},
	} {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `{"ok":true}` })
		c, out := newTestClient(srv.URL, "tok")
		if err := tc.run(c, []string{"docs/api"}); err != nil {
			t.Fatal(err)
		}
		if len(*reqs) != 1 || (*reqs)[0].method != "PATCH" || (*reqs)[0].path != "/api/sites/docs/api" || string((*reqs)[0].body) != tc.body || !strings.Contains(out.String(), tc.out) {
			t.Fatalf("request = %+v, out = %q", *reqs, out.String())
		}
	}

	// An admin's archive is reported, not swallowed.
	srv, _ := recordingServer(t, func(r *capturedReq) (int, string) { return 403, `{"error":"archived by an admin"}` })
	c, _ := newTestClient(srv.URL, "tok")
	if err := c.unarchive([]string{"docs/api"}); err == nil || !strings.Contains(err.Error(), "archived by an admin") {
		t.Fatalf("err = %v", err)
	}
}
