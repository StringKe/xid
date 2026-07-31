package xid

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExchangeSessionToken_ExactSameOriginSuccess(t *testing.T) {
	var method, cookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		cookie = r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"jwt-value"}`))
	}))
	defer server.Close()

	client, err := NewClient(ClientOptions{Issuer: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	token, err := client.ExchangeSessionToken(
		context.Background(),
		server.URL+"/api",
		"__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc",
		server.URL+sessionTokenPath,
	)
	if err != nil {
		t.Fatalf("exchange failed: %v", err)
	}
	if token != "jwt-value" || method != http.MethodPost {
		t.Fatalf("unexpected exchange result token=%q method=%q", token, method)
	}
	if cookie != "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc" {
		t.Fatalf("complete Cookie header not forwarded: %q", cookie)
	}
}

func TestExchangeSessionToken_RejectsCrossOriginBeforeRequest(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client, _ := NewClient(ClientOptions{Issuer: "https://app.example", HTTPClient: server.Client()})
	_, err := client.ExchangeSessionToken(
		context.Background(),
		"https://app.example/api",
		"__Host-xid.rt.abc=opaque",
		server.URL+sessionTokenPath,
	)
	if err == nil || !strings.Contains(err.Error(), "same-origin") {
		t.Fatalf("expected same-origin error, got %v", err)
	}
	if called {
		t.Fatal("cross-origin endpoint was called")
	}
}

func TestExchangeSessionToken_RejectsRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/sign-in", http.StatusFound)
	}))
	defer server.Close()

	client, _ := NewClient(ClientOptions{Issuer: server.URL, HTTPClient: server.Client()})
	_, err := client.ExchangeSessionToken(
		context.Background(),
		server.URL+"/api",
		"__Host-xid.rt.abc=opaque",
		server.URL+sessionTokenPath,
	)
	if err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Fatalf("expected redirect rejection, got %v", err)
	}
}

func TestExchangeSessionToken_RejectsInvalidResponse(t *testing.T) {
	cases := []string{
		`{"jwt":"wrong"}`,
		`{"token":""}`,
		`{"token":"jwt","extra":true}`,
		`not-json`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()

			client, _ := NewClient(ClientOptions{Issuer: server.URL, HTTPClient: server.Client()})
			if _, err := client.ExchangeSessionToken(
				context.Background(),
				server.URL+"/api",
				"__Host-xid.rt.abc=opaque",
				server.URL+sessionTokenPath,
			); err == nil {
				t.Fatal("expected invalid response error")
			}
		})
	}
}
