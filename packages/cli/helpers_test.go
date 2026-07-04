package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// capturedReq records what a command actually sent, so tests assert the HTTP contract.
type capturedReq struct {
	method string
	path   string // includes RawQuery
	auth   string
	ct     string
	body   []byte
}

// newTestClient wires a client to a test server with interactive/network side effects stubbed out.
func newTestClient(baseURL, token string) (*client, *bytes.Buffer) {
	var buf bytes.Buffer
	c := newClient(baseURL, token, &buf)
	c.errOut = io.Discard
	c.sleep = func(time.Duration) {}
	c.openBrowser = func(string) {}
	c.in = strings.NewReader("")
	c.stdin = strings.NewReader("")
	c.stdinIsTTY = false
	return c, &buf
}

// recordingServer returns an httptest server that records every request and replies with the
// (status, body) chosen by route(path). route returns (-1, "") to fall back to 200 "{}".
func recordingServer(t *testing.T, route func(r *capturedReq) (int, string)) (*httptest.Server, *[]capturedReq) {
	t.Helper()
	var reqs []capturedReq
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		cr := capturedReq{
			method: r.Method,
			path:   r.URL.RequestURI(),
			auth:   r.Header.Get("Authorization"),
			ct:     r.Header.Get("Content-Type"),
			body:   body,
		}
		reqs = append(reqs, cr)
		status, payload := route(&cr)
		if status < 0 {
			status, payload = 200, "{}"
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	return srv, &reqs
}

func readAll(r interface{ Read([]byte) (int, error) }) []byte {
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(r)
	return buf.Bytes()
}
