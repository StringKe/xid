// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT
//
// Package xid - client construction and JWKS caching.

package xid

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// ClientOptions configures a Client instance.
type ClientOptions struct {
	// Issuer is the XID instance issuer URL, e.g. "https://xid.dev".
	// Required. Used to validate the JWT iss claim and to derive the JWKS endpoint.
	Issuer string

	// Audience is the expected JWT aud claim value (typically your client_id).
	// When empty, aud validation is skipped.
	Audience string

	// WebhookSecret is the HMAC-SHA256 signing secret for webhook endpoints.
	// Accepts the svix "whsec_<base64>" format or a raw base64 string.
	WebhookSecret string

	// AuthorizedParties is an optional whitelist of allowed azp (authorized party)
	// values. When non-empty, tokens whose azp is not in this list are rejected.
	AuthorizedParties []string

	// ClockToleranceSec is the allowed clock skew in seconds for exp/nbf validation.
	// Defaults to 60 seconds, consistent with @xid-kit/backend.
	ClockToleranceSec int

	// CookieName is an application-owned short-lived JWT cookie name.
	// Empty disables cookie fallback; Authorization: Bearer is the only default.
	CookieName string

	// JWKSCacheTTL is how long fetched JWKS public keys are cached.
	// Defaults to 1 hour, consistent with the KV JWKS cache TTL in the server.
	JWKSCacheTTL time.Duration

	// HTTPClient is used for JWKS fetches.
	// When nil, a default client with a 10s timeout is used.
	HTTPClient *http.Client
}

const (
	defaultClockToleranceSec = 60
)

// Client is the XID server-side SDK entry point.
// Construct once with NewClient and reuse across requests (JWKS cache is shared).
type Client struct {
	opts       ClientOptions
	jwksCache  *jwksCache
	httpClient *http.Client
}

// NewClient constructs a Client with the given options.
// Issuer is required; all other fields have sensible defaults.
func NewClient(opts ClientOptions) (*Client, error) {
	if opts.Issuer == "" {
		return nil, fmt.Errorf("xid: Issuer must not be empty")
	}
	if opts.JWKSCacheTTL <= 0 {
		opts.JWKSCacheTTL = time.Hour
	}
	if opts.ClockToleranceSec <= 0 {
		opts.ClockToleranceSec = defaultClockToleranceSec
	}
	hc := opts.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{
		opts:       opts,
		jwksCache:  newJWKSCache(),
		httpClient: hc,
	}, nil
}

// jwksCache holds the parsed public key set fetched from /jwks, with TTL.
type jwksCache struct {
	mu        sync.RWMutex
	keys      map[string]parsedKey // kid -> parsed public key
	fetchedAt time.Time
}

func newJWKSCache() *jwksCache {
	return &jwksCache{keys: make(map[string]parsedKey)}
}

// getKeys returns the current valid key set, refreshing from the JWKS endpoint when stale.
// On fetch failure, returns the stale cache if available (graceful degradation).
func (c *Client) getKeys(ctx context.Context) (map[string]parsedKey, error) {
	cache := c.jwksCache
	cache.mu.RLock()
	if !cache.fetchedAt.IsZero() && time.Since(cache.fetchedAt) < c.opts.JWKSCacheTTL {
		keys := cache.keys
		cache.mu.RUnlock()
		return keys, nil
	}
	cache.mu.RUnlock()

	// Upgrade to write lock and double-check.
	cache.mu.Lock()
	defer cache.mu.Unlock()

	if !cache.fetchedAt.IsZero() && time.Since(cache.fetchedAt) < c.opts.JWKSCacheTTL {
		return cache.keys, nil
	}

	keys, err := c.fetchJWKS(ctx)
	if err != nil {
		// Degrade to stale cache rather than failing hard.
		if len(cache.keys) > 0 {
			return cache.keys, nil
		}
		return nil, err
	}
	cache.keys = keys
	cache.fetchedAt = time.Now()
	return cache.keys, nil
}

// fetchJWKS fetches and parses the JWKS from issuer/jwks.
func (c *Client) fetchJWKS(ctx context.Context) (map[string]parsedKey, error) {
	url := c.opts.Issuer + "/jwks"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("xid: build jwks request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("xid: fetch jwks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("xid: jwks endpoint returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("xid: read jwks body: %w", err)
	}

	var raw jwksResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("xid: parse jwks: %w", err)
	}

	result := make(map[string]parsedKey, len(raw.Keys))
	for _, k := range raw.Keys {
		pk, err := parseJWK(k)
		if err != nil {
			// Skip unrecognised key types (forward compatibility).
			continue
		}
		result[k.Kid] = pk
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("xid: jwks contained no usable keys")
	}
	return result, nil
}

// jwksResponse is the JSON shape of a JWKS endpoint response.
type jwksResponse struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	// EC fields
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	// RSA fields
	N string `json:"n"`
	E string `json:"e"`
}
