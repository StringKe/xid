// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT

package xid

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ---- test key helpers -------------------------------------------------------

// testECKey holds an ES256 key pair plus its JWK representation.
type testECKey struct {
	priv *ecdsa.PrivateKey
	kid  string
}

func newTestECKey(t *testing.T, kid string) *testECKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate EC key: %v", err)
	}
	return &testECKey{priv: priv, kid: kid}
}

// publicJWK returns the EC public key as a jwk struct.
func (k *testECKey) publicJWK() jwk {
	pub := k.priv.Public().(*ecdsa.PublicKey)
	xBytes := pub.X.Bytes()
	yBytes := pub.Y.Bytes()
	// Pad to 32 bytes for P-256.
	xBytes = padLeft(xBytes, 32)
	yBytes = padLeft(yBytes, 32)
	return jwk{
		Kid: k.kid,
		Kty: "EC",
		Alg: "ES256",
		Use: "sig",
		Crv: "P-256",
		X:   base64.RawURLEncoding.EncodeToString(xBytes),
		Y:   base64.RawURLEncoding.EncodeToString(yBytes),
	}
}

func padLeft(b []byte, size int) []byte {
	if len(b) >= size {
		return b
	}
	padded := make([]byte, size)
	copy(padded[size-len(b):], b)
	return padded
}

// signToken signs a JWT with this key. claims is merged with RegisteredClaims.
func (k *testECKey) signToken(t *testing.T, registered jwt.RegisteredClaims, extra map[string]any) string {
	t.Helper()
	type compositeClaims struct {
		jwt.RegisteredClaims
		ClientID        string   `json:"client_id,omitempty"`
		Scope           string   `json:"scope,omitempty"`
		AMR             []string `json:"amr,omitempty"`
		AuthorizedParty string   `json:"azp,omitempty"`
		OrgID           string   `json:"org_id,omitempty"`
	}
	c := compositeClaims{RegisteredClaims: registered}
	if v, ok := extra["azp"]; ok {
		c.AuthorizedParty, _ = v.(string)
	}
	if v, ok := extra["client_id"]; ok {
		c.ClientID, _ = v.(string)
	}
	if v, ok := extra["amr"]; ok {
		c.AMR, _ = v.([]string)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, c)
	tok.Header["kid"] = k.kid
	signed, err := tok.SignedString(k.priv)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

// jwksServer returns an httptest.Server that serves a JWKS containing this key.
func (k *testECKey) jwksServer(t *testing.T) *httptest.Server {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"keys": []jwk{k.publicJWK()},
	})
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
}

// newClientWithServer creates a Client pointing at the given JWKS server.
func newClientWithServer(t *testing.T, srv *httptest.Server, opts ClientOptions) *Client {
	t.Helper()
	opts.Issuer = srv.URL
	c, err := NewClient(opts)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// ---- NewClient tests --------------------------------------------------------

func TestNewClient_RequiresIssuer(t *testing.T) {
	_, err := NewClient(ClientOptions{})
	if err == nil {
		t.Fatal("expected error when Issuer is empty")
	}
}

func TestNewClient_Defaults(t *testing.T) {
	c, err := NewClient(ClientOptions{Issuer: "https://xid.dev"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.opts.ClockToleranceSec != defaultClockToleranceSec {
		t.Errorf("ClockToleranceSec: got %d, want %d", c.opts.ClockToleranceSec, defaultClockToleranceSec)
	}
	if c.opts.CookieName != "" {
		t.Errorf("CookieName: got %q, want disabled default", c.opts.CookieName)
	}
	if c.opts.JWKSCacheTTL != time.Hour {
		t.Errorf("JWKSCacheTTL: got %v, want 1h", c.opts.JWKSCacheTTL)
	}
}

// ---- VerifyAccessToken tests ------------------------------------------------

func TestVerifyAccessToken_ValidES256(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{Audience: "test-client"})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-123",
		Audience:  jwt.ClaimStrings{"test-client"},
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	claims, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if claims.Subject != "user-123" {
		t.Errorf("subject: got %q, want %q", claims.Subject, "user-123")
	}
}

func TestClaims_IsGuest(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})
	now := time.Now()

	sign := func(extra map[string]any) string {
		return key.signToken(t, jwt.RegisteredClaims{
			Issuer:    srv.URL,
			Subject:   "user-1",
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(now),
		}, extra)
	}

	cases := []struct {
		name  string
		extra map[string]any
		want  bool
	}{
		{"guest amr", map[string]any{"amr": []string{"guest"}}, true},
		{"guest among others", map[string]any{"amr": []string{"pwd", "guest"}}, true},
		{"non-guest amr", map[string]any{"amr": []string{"pwd"}}, false},
		{"empty amr", map[string]any{"amr": []string{}}, false},
		{"no amr", nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := c.VerifyAccessToken(context.Background(), sign(tc.extra))
			if err != nil {
				t.Fatalf("expected no error, got: %v", err)
			}
			if got := claims.IsGuest(); got != tc.want {
				t.Errorf("IsGuest: got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestVerifyAccessToken_EmptyToken(t *testing.T) {
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev"})
	_, err := c.VerifyAccessToken(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
	sdkErr, ok := err.(*SDKError)
	if !ok {
		t.Fatalf("expected *SDKError, got %T", err)
	}
	if sdkErr.Code != ErrCodeTokenMissing {
		t.Errorf("code: got %q, want %q", sdkErr.Code, ErrCodeTokenMissing)
	}
}

func TestVerifyAccessToken_ExpiredToken(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{ClockToleranceSec: 0})

	past := time.Now().Add(-10 * time.Minute)
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-123",
		ExpiresAt: jwt.NewNumericDate(past),
		IssuedAt:  jwt.NewNumericDate(past.Add(-5 * time.Minute)),
	}, nil)

	_, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}

func TestVerifyAccessToken_WrongIssuer(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	// Sign with a different issuer
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    "https://evil.example.com",
		Subject:   "user-123",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	_, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err == nil {
		t.Fatal("expected error for wrong issuer")
	}
}

func TestVerifyAccessToken_RejectsNoneAlg(t *testing.T) {
	// Craft a "none" alg token manually.
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"evil","iss":"x","exp":9999999999,"iat":1}`))
	noneToken := header + "." + payload + "."

	c, _ := NewClient(ClientOptions{Issuer: "x"})
	_, err := c.VerifyAccessToken(context.Background(), noneToken)
	if err == nil {
		t.Fatal("expected error for alg=none token")
	}
}

func TestVerifyAccessToken_RejectsHS256Alg(t *testing.T) {
	// Craft an HS256 token header.
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT","kid":"k1"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"evil","iss":"x","exp":9999999999,"iat":1}`))
	fakeToken := header + "." + payload + ".fakesig"

	c, _ := NewClient(ClientOptions{Issuer: "x"})
	_, err := c.VerifyAccessToken(context.Background(), fakeToken)
	if err == nil {
		t.Fatal("expected error for HS256 token")
	}
}

func TestVerifyAccessToken_AuthorizedParties_Pass(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{
		AuthorizedParties: []string{"my-app", "other-app"},
	})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-1",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, map[string]any{"azp": "my-app"})

	claims, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if claims.AuthorizedParty != "my-app" {
		t.Errorf("azp: got %q, want %q", claims.AuthorizedParty, "my-app")
	}
}

func TestVerifyAccessToken_AuthorizedParties_Fail(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{
		AuthorizedParties: []string{"trusted-app"},
	})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-1",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, map[string]any{"azp": "untrusted-app"})

	_, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err == nil {
		t.Fatal("expected error for unauthorized azp")
	}
}

func TestVerifyAccessToken_ClockTolerance(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	// Token expired 30 seconds ago, but tolerance is 60 seconds -> should pass.
	c := newClientWithServer(t, srv, ClientOptions{ClockToleranceSec: 60})

	past := time.Now().Add(-30 * time.Second)
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-1",
		ExpiresAt: jwt.NewNumericDate(past),
		IssuedAt:  jwt.NewNumericDate(past.Add(-5 * time.Minute)),
	}, nil)

	_, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("token within tolerance should pass, got: %v", err)
	}
}

func TestVerifyAccessToken_KeyRotation_KidMiss(t *testing.T) {
	// First key is in the initial JWKS; second key gets added on refresh.
	key1 := newTestECKey(t, "key-old")
	key2 := newTestECKey(t, "key-new")

	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		var keys []jwk
		if callCount >= 2 {
			// On refresh, return both keys.
			keys = []jwk{key1.publicJWK(), key2.publicJWK()}
		} else {
			keys = []jwk{key1.publicJWK()}
		}
		body, _ := json.Marshal(map[string]any{"keys": keys})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	// Token signed by key2 (not yet in cache).
	tokenStr := key2.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-2",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	claims, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("should succeed after key rotation refresh, got: %v", err)
	}
	if claims.Subject != "user-2" {
		t.Errorf("subject: got %q", claims.Subject)
	}
	if callCount < 2 {
		t.Errorf("expected at least 2 JWKS fetches (initial + rotation refresh), got %d", callCount)
	}
}

func TestVerifyAccessToken_RSA256(t *testing.T) {
	// Generate an RSA key pair and sign a token with RS256.
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	kid := "rsa-key-1"

	// Build RSA JWK
	nBytes := rsaKey.PublicKey.N.Bytes()
	eBytes := big.NewInt(int64(rsaKey.PublicKey.E)).Bytes()
	rsaJWK := jwk{
		Kid: kid,
		Kty: "RSA",
		Alg: "RS256",
		Use: "sig",
		N:   base64.RawURLEncoding.EncodeToString(nBytes),
		E:   base64.RawURLEncoding.EncodeToString(eBytes),
	}

	body, _ := json.Marshal(map[string]any{"keys": []jwk{rsaJWK}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	type rsaClaims struct {
		jwt.RegisteredClaims
	}
	rc := rsaClaims{RegisteredClaims: jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "rsa-user",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, rc)
	tok.Header["kid"] = kid
	tokenStr, err := tok.SignedString(rsaKey)
	if err != nil {
		t.Fatalf("sign RSA token: %v", err)
	}

	claims, err := c.VerifyAccessToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("RS256 token should verify, got: %v", err)
	}
	if claims.Subject != "rsa-user" {
		t.Errorf("subject: got %q", claims.Subject)
	}
}

// ---- AuthenticateRequest tests ----------------------------------------------

func TestAuthenticateRequest_BearerHeader(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-bearer",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	r := httptest.NewRequest(http.MethodGet, "/api", nil)
	r.Header.Set("Authorization", "Bearer "+tokenStr)

	state := c.AuthenticateRequest(r.Context(), r)
	if !state.Authenticated {
		t.Fatalf("expected authenticated, reason: %s", state.Reason)
	}
	if state.Claims.Subject != "user-bearer" {
		t.Errorf("subject: got %q", state.Claims.Subject)
	}
}

func TestAuthenticateRequest_DoesNotUseImplicitOrCoreCookie(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-cookie",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	r := httptest.NewRequest(http.MethodGet, "/api", nil)
	r.AddCookie(&http.Cookie{Name: "__session", Value: tokenStr})
	r.AddCookie(&http.Cookie{Name: "__Host-xid.rt.abcdefgh", Value: tokenStr})

	state := c.AuthenticateRequest(r.Context(), r)
	if state.Authenticated || state.Reason != "no_token" {
		t.Fatalf("expected implicit cookies to be ignored, got: %#v", state)
	}
}

func TestAuthenticateRequest_CustomCookieName(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{CookieName: "my_session"})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-custom-cookie",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	r := httptest.NewRequest(http.MethodGet, "/api", nil)
	r.AddCookie(&http.Cookie{Name: "my_session", Value: tokenStr})

	state := c.AuthenticateRequest(r.Context(), r)
	if !state.Authenticated {
		t.Fatalf("expected authenticated via custom cookie, reason: %s", state.Reason)
	}
}

func TestAuthenticateRequest_NoToken(t *testing.T) {
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev"})
	r := httptest.NewRequest(http.MethodGet, "/api", nil)

	state := c.AuthenticateRequest(r.Context(), r)
	if state.Authenticated {
		t.Fatal("expected not authenticated when no token present")
	}
	if state.Reason != "no_token" {
		t.Errorf("reason: got %q, want %q", state.Reason, "no_token")
	}
}

func TestAuthenticateRequest_HeaderTakesPriorityOverCookie(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	headerToken := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "from-header",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)
	cookieToken := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "from-cookie",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	r := httptest.NewRequest(http.MethodGet, "/api", nil)
	r.Header.Set("Authorization", "Bearer "+headerToken)
	r.AddCookie(&http.Cookie{Name: "__session", Value: cookieToken})

	state := c.AuthenticateRequest(r.Context(), r)
	if !state.Authenticated {
		t.Fatalf("expected authenticated, reason: %s", state.Reason)
	}
	if state.Claims.Subject != "from-header" {
		t.Errorf("header should take priority; subject: got %q, want %q", state.Claims.Subject, "from-header")
	}
}

// ---- Middleware tests -------------------------------------------------------

func TestMiddleware_PassesClaimsToContext(t *testing.T) {
	key := newTestECKey(t, "key-1")
	srv := key.jwksServer(t)
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{})

	now := time.Now()
	tokenStr := key.signToken(t, jwt.RegisteredClaims{
		Issuer:    srv.URL,
		Subject:   "user-middleware",
		ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		IssuedAt:  jwt.NewNumericDate(now),
	}, nil)

	var capturedClaims *Claims
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedClaims = ClaimsFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	handler := c.Middleware(inner, nil)
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rec.Code)
	}
	if capturedClaims == nil {
		t.Fatal("claims not injected into context")
	}
	if capturedClaims.Subject != "user-middleware" {
		t.Errorf("subject: got %q", capturedClaims.Subject)
	}
}

func TestMiddleware_Returns401WhenUnauthenticated(t *testing.T) {
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev"})

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler should not be called")
	})

	handler := c.Middleware(inner, nil)
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d, want 401", rec.Code)
	}
}

func TestClaimsFromContext_NilWhenAbsent(t *testing.T) {
	ctx := context.Background()
	if ClaimsFromContext(ctx) != nil {
		t.Error("expected nil claims from empty context")
	}
}

// ---- parseJWK tests ---------------------------------------------------------

func TestParseJWK_EC_P256(t *testing.T) {
	key := newTestECKey(t, "k1")
	pk, err := parseJWK(key.publicJWK())
	if err != nil {
		t.Fatalf("parseJWK EC: %v", err)
	}
	if pk.Kid != "k1" {
		t.Errorf("kid: %q", pk.Kid)
	}
	if _, ok := pk.Key.(*ecdsa.PublicKey); !ok {
		t.Error("expected *ecdsa.PublicKey")
	}
}

func TestParseJWK_UnsupportedKty(t *testing.T) {
	_, err := parseJWK(jwk{Kty: "oct", Kid: "k1"})
	if err == nil {
		t.Fatal("expected error for unsupported kty")
	}
}

func TestParseJWK_RSA(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	nBytes := rsaKey.PublicKey.N.Bytes()
	eBytes := big.NewInt(int64(rsaKey.PublicKey.E)).Bytes()
	k := jwk{
		Kid: "rsa-1",
		Kty: "RSA",
		Alg: "RS256",
		N:   base64.RawURLEncoding.EncodeToString(nBytes),
		E:   base64.RawURLEncoding.EncodeToString(eBytes),
	}
	pk, err := parseJWK(k)
	if err != nil {
		t.Fatalf("parseJWK RSA: %v", err)
	}
	if _, ok := pk.Key.(*rsa.PublicKey); !ok {
		t.Error("expected *rsa.PublicKey")
	}
}

// ---- VerifyWebhook tests ----------------------------------------------------

// buildWebhookSecret creates a whsec_-prefixed secret and returns both the
// prefixed form (to pass to ClientOptions) and the raw bytes (for computing expected MACs).
func buildWebhookSecret(t *testing.T) (prefixed string, rawBytes []byte) {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(raw)
	return whsecPrefix + encoded, raw
}

// buildWebhookRequest constructs an *http.Request with proper svix headers.
func buildWebhookRequest(t *testing.T, id, timestampStr, body string, secretBytes []byte) *http.Request {
	t.Helper()
	signedContent := id + "." + timestampStr + "." + body
	mac := computeHMACSHA256(secretBytes, signedContent)
	sig := "v1," + base64.StdEncoding.EncodeToString(mac)

	r := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	r.Header.Set("svix-id", id)
	r.Header.Set("svix-timestamp", timestampStr)
	r.Header.Set("svix-signature", sig)
	return r
}

func TestVerifyWebhook_ValidSignature(t *testing.T) {
	prefixed, rawBytes := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	now := time.Now()
	tsStr := fmt.Sprintf("%d", now.Unix())
	body := `{"type":"user.created","data":{"id":"u1"}}`

	r := buildWebhookRequest(t, "evt_001", tsStr, body, rawBytes)
	event, err := c.verifyWebhookAt(r, now)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if event.ID != "evt_001" {
		t.Errorf("ID: got %q, want %q", event.ID, "evt_001")
	}
	if string(event.Body) != body {
		t.Errorf("body mismatch")
	}
}

func TestVerifyWebhook_LegacyHexSecret(t *testing.T) {
	legacySecret := strings.Repeat("ab", 32)
	c, _ := NewClient(ClientOptions{
		Issuer:        "https://xid.dev",
		WebhookSecret: legacySecret,
	})

	now := time.Now()
	tsStr := fmt.Sprintf("%d", now.Unix())
	body := `{"type":"user.updated","data":{"id":"u1"}}`
	r := buildWebhookRequest(t, "evt_legacy", tsStr, body, []byte(legacySecret))

	if _, err := c.verifyWebhookAt(r, now); err != nil {
		t.Fatalf("expected legacy hex secret to verify as UTF-8 key material, got: %v", err)
	}
}

func TestVerifyWebhook_MissingHeaders(t *testing.T) {
	prefixed, _ := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	// Missing svix-signature
	r := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader("{}"))
	r.Header.Set("svix-id", "evt_001")
	r.Header.Set("svix-timestamp", fmt.Sprintf("%d", time.Now().Unix()))

	_, err := c.verifyWebhookAt(r, time.Now())
	if err == nil {
		t.Fatal("expected error for missing headers")
	}
	sdkErr, ok := err.(*SDKError)
	if !ok || sdkErr.Code != ErrCodeWebhookInvalid {
		t.Errorf("expected webhook_invalid SDKError, got: %v", err)
	}
}

func TestVerifyWebhook_TimestampTooOld(t *testing.T) {
	prefixed, rawBytes := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	now := time.Now()
	// 10 minutes in the past
	oldTs := now.Add(-10 * time.Minute)
	tsStr := fmt.Sprintf("%d", oldTs.Unix())

	r := buildWebhookRequest(t, "evt_old", tsStr, "{}", rawBytes)
	_, err := c.verifyWebhookAt(r, now)
	if err == nil {
		t.Fatal("expected error for old timestamp")
	}
	sdkErr, ok := err.(*SDKError)
	if !ok || sdkErr.Code != ErrCodeWebhookInvalid {
		t.Errorf("expected webhook_invalid SDKError, got: %v", err)
	}
}

func TestVerifyWebhook_TimestampTooFarInFuture(t *testing.T) {
	prefixed, rawBytes := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	now := time.Now()
	futureTs := now.Add(10 * time.Minute)
	tsStr := fmt.Sprintf("%d", futureTs.Unix())

	r := buildWebhookRequest(t, "evt_future", tsStr, "{}", rawBytes)
	_, err := c.verifyWebhookAt(r, now)
	if err == nil {
		t.Fatal("expected error for future timestamp")
	}
}

func TestVerifyWebhook_InvalidSignature(t *testing.T) {
	prefixed, _ := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	now := time.Now()
	tsStr := fmt.Sprintf("%d", now.Unix())

	r := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(`{}`))
	r.Header.Set("svix-id", "evt_tampered")
	r.Header.Set("svix-timestamp", tsStr)
	r.Header.Set("svix-signature", "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")

	_, err := c.verifyWebhookAt(r, now)
	if err == nil {
		t.Fatal("expected error for invalid signature")
	}
}

func TestVerifyWebhook_MultipleSignatures_AnyMatches(t *testing.T) {
	// Key rotation: signature header contains two v1 sigs, one old/wrong and one valid.
	prefixed, rawBytes := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	now := time.Now()
	tsStr := fmt.Sprintf("%d", now.Unix())
	body := `{"type":"user.updated"}`
	signedContent := "evt_multi" + "." + tsStr + "." + body
	mac := computeHMACSHA256(rawBytes, signedContent)
	validSig := "v1," + base64.StdEncoding.EncodeToString(mac)
	invalidSig := "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

	r := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	r.Header.Set("svix-id", "evt_multi")
	r.Header.Set("svix-timestamp", tsStr)
	// Space-separated: invalid first, valid second.
	r.Header.Set("svix-signature", invalidSig+" "+validSig)

	event, err := c.verifyWebhookAt(r, now)
	if err != nil {
		t.Fatalf("expected no error when any signature matches, got: %v", err)
	}
	if event.ID != "evt_multi" {
		t.Errorf("ID: got %q", event.ID)
	}
}

func TestVerifyWebhook_NoSecretConfigured(t *testing.T) {
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev"})
	r := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader("{}"))
	r.Header.Set("svix-id", "evt_001")
	r.Header.Set("svix-timestamp", fmt.Sprintf("%d", time.Now().Unix()))
	r.Header.Set("svix-signature", "v1,fake")

	_, err := c.VerifyWebhook(r)
	if err == nil {
		t.Fatal("expected error when WebhookSecret is not configured")
	}
	sdkErr, ok := err.(*SDKError)
	if !ok || sdkErr.Code != ErrCodeConfigInvalid {
		t.Errorf("expected config_invalid error, got: %v", err)
	}
}

func TestVerifyWebhook_BodyTamperedAfterSigning(t *testing.T) {
	prefixed, rawBytes := buildWebhookSecret(t)
	c, _ := NewClient(ClientOptions{Issuer: "https://xid.dev", WebhookSecret: prefixed})

	now := time.Now()
	tsStr := fmt.Sprintf("%d", now.Unix())
	originalBody := `{"type":"user.created"}`

	r := buildWebhookRequest(t, "evt_tamper", tsStr, originalBody, rawBytes)
	// Replace body with tampered content after headers are signed.
	r.Body = io.NopCloser(strings.NewReader(`{"type":"user.deleted"}`))

	_, err := c.verifyWebhookAt(r, now)
	if err == nil {
		t.Fatal("expected error when body is tampered")
	}
}

// ---- decodeWebhookSecret tests ----------------------------------------------

func TestDecodeWebhookSecret_WithPrefix(t *testing.T) {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	prefixed := whsecPrefix + base64.StdEncoding.EncodeToString(raw)

	decoded, err := decodeWebhookSecret(prefixed)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(decoded) != string(raw) {
		t.Error("decoded secret does not match original")
	}
}

func TestDecodeWebhookSecret_WithoutPrefix(t *testing.T) {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	plain := base64.StdEncoding.EncodeToString(raw)

	decoded, err := decodeWebhookSecret(plain)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(decoded) != string(raw) {
		t.Error("decoded secret does not match original")
	}
}

func TestDecodeWebhookSecret_InvalidBase64(t *testing.T) {
	_, err := decodeWebhookSecret("whsec_!!!notbase64!!!")
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

// ---- SDKError tests ---------------------------------------------------------

func TestSDKError_WithCause(t *testing.T) {
	cause := fmt.Errorf("root cause")
	e := &SDKError{Code: ErrCodeTokenInvalid, Message: "bad token", Cause: cause}
	msg := e.Error()
	if !strings.Contains(msg, "token_invalid") {
		t.Errorf("error string missing code: %q", msg)
	}
	if !strings.Contains(msg, "root cause") {
		t.Errorf("error string missing cause: %q", msg)
	}
	if e.Unwrap() != cause {
		t.Error("Unwrap should return cause")
	}
}

func TestSDKError_WithoutCause(t *testing.T) {
	e := &SDKError{Code: ErrCodeTokenExpired, Message: "expired"}
	msg := e.Error()
	if !strings.Contains(msg, "token_expired") {
		t.Errorf("error string missing code: %q", msg)
	}
}

// ---- isSupportedAlg tests ---------------------------------------------------

func TestIsSupportedAlg(t *testing.T) {
	accepted := []string{"ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512"}
	rejected := []string{"none", "HS256", "HS384", "HS512", "", "UNKNOWN"}

	for _, alg := range accepted {
		if !isSupportedAlg(alg) {
			t.Errorf("expected %q to be supported", alg)
		}
	}
	for _, alg := range rejected {
		if isSupportedAlg(alg) {
			t.Errorf("expected %q to be rejected", alg)
		}
	}
}

// ---- JWKS cache tests -------------------------------------------------------

func TestJWKSCache_Deduplication(t *testing.T) {
	key := newTestECKey(t, "key-1")
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		body, _ := json.Marshal(map[string]any{"keys": []jwk{key.publicJWK()}})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{JWKSCacheTTL: time.Minute})

	// Two calls within TTL should only trigger one fetch.
	_, _ = c.getKeys(context.Background())
	_, _ = c.getKeys(context.Background())

	if callCount != 1 {
		t.Errorf("expected 1 JWKS fetch, got %d", callCount)
	}
}

func TestJWKSCache_RefreshAfterTTL(t *testing.T) {
	key := newTestECKey(t, "key-1")
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		body, _ := json.Marshal(map[string]any{"keys": []jwk{key.publicJWK()}})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := newClientWithServer(t, srv, ClientOptions{JWKSCacheTTL: time.Millisecond})

	_, _ = c.getKeys(context.Background())
	time.Sleep(5 * time.Millisecond) // let the TTL expire
	_, _ = c.getKeys(context.Background())

	if callCount < 2 {
		t.Errorf("expected at least 2 JWKS fetches after TTL expiry, got %d", callCount)
	}
}
