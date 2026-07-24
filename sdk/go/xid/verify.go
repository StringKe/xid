// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT
//
// JWT verification and request authentication.

package xid

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims holds the standard and XID-extended claims from an access token.
// Corresponds to OIDC Core + XID extensions (see docs/design/03-oidc-oauth.md).
type Claims struct {
	jwt.RegisteredClaims

	// Standard OIDC/OAuth2 claims
	ClientID string   `json:"client_id,omitempty"`
	Scope    string   `json:"scope,omitempty"`
	AMR      []string `json:"amr,omitempty"`
	ACR      string   `json:"acr,omitempty"`

	// azp: authorized party (the client that was issued the token)
	AuthorizedParty string `json:"azp,omitempty"`

	// XID extension claims
	OrgID   string `json:"org_id,omitempty"`
	OrgSlug string `json:"org_slug,omitempty"`
}

// AuthState represents the authentication outcome of a request.
type AuthState struct {
	// Authenticated is true when the JWT was valid and claims are trustworthy.
	Authenticated bool

	// Claims holds the verified token payload. Only valid when Authenticated is true.
	Claims *Claims

	// Reason is a short, non-sensitive description of why authentication failed.
	// Suitable for server-side logs; never returned to clients.
	Reason string
}

// VerifyAccessToken validates a raw XID access token string.
//
// Steps:
//  1. Parse JWT header to read kid and alg.
//  2. Reject unsupported algorithms (alg whitelist; rejects "none"/HS*).
//  3. Fetch the matching public key from the JWKS cache (refresh on miss).
//  4. Verify signature, exp/nbf (with configured clock tolerance), iss, and aud.
//  5. Verify azp against AuthorizedParties when configured.
//
// Returns *Claims or a descriptive error.
func (c *Client) VerifyAccessToken(ctx context.Context, tokenStr string) (*Claims, error) {
	if tokenStr == "" {
		return nil, &SDKError{Code: ErrCodeTokenMissing, Message: "token is empty"}
	}

	keyFunc := func(token *jwt.Token) (any, error) {
		kid, _ := token.Header["kid"].(string)
		alg, _ := token.Header["alg"].(string)

		if !isSupportedAlg(alg) {
			return nil, &SDKError{
				Code:    ErrCodeTokenInvalid,
				Message: fmt.Sprintf("unsupported algorithm %q", alg),
			}
		}

		keys, err := c.getKeys(ctx)
		if err != nil {
			return nil, &SDKError{Code: ErrCodeJWKSFetchFailed, Message: "failed to fetch JWKS", Cause: err}
		}

		pk, ok := keys[kid]
		if !ok {
			// kid not in cache: force one refresh (key rotation scenario).
			fresh, fetchErr := c.fetchJWKS(ctx)
			if fetchErr != nil {
				return nil, &SDKError{Code: ErrCodeJWKSFetchFailed, Message: "failed to re-fetch JWKS after kid miss", Cause: fetchErr}
			}
			c.jwksCache.mu.Lock()
			c.jwksCache.keys = fresh
			c.jwksCache.fetchedAt = time.Now()
			c.jwksCache.mu.Unlock()

			pk, ok = fresh[kid]
			if !ok {
				return nil, &SDKError{Code: ErrCodeTokenInvalid, Message: fmt.Sprintf("unknown kid %q", kid)}
			}
		}

		return pk.Key, nil
	}

	leeway := time.Duration(c.opts.ClockToleranceSec) * time.Second

	parserOpts := []jwt.ParserOption{
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(leeway),
		jwt.WithValidMethods([]string{
			"ES256", "ES384", "ES512",
			"RS256", "RS384", "RS512",
			"PS256", "PS384", "PS512",
		}),
		jwt.WithIssuer(c.opts.Issuer),
	}
	if c.opts.Audience != "" {
		parserOpts = append(parserOpts, jwt.WithAudience(c.opts.Audience))
	}

	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, keyFunc, parserOpts...)
	if err != nil {
		return nil, &SDKError{Code: ErrCodeTokenInvalid, Message: "token validation failed", Cause: err}
	}

	if err := c.checkAuthorizedParty(claims); err != nil {
		return nil, err
	}

	return claims, nil
}

// checkAuthorizedParty validates azp against the configured AuthorizedParties whitelist.
func (c *Client) checkAuthorizedParty(claims *Claims) error {
	if len(c.opts.AuthorizedParties) == 0 {
		return nil
	}
	for _, ap := range c.opts.AuthorizedParties {
		if claims.AuthorizedParty == ap {
			return nil
		}
	}
	return &SDKError{
		Code:    ErrCodeTokenInvalid,
		Message: fmt.Sprintf("azp %q not in authorized parties", claims.AuthorizedParty),
	}
}

// isSupportedAlg is the algorithm whitelist.
// Only asymmetric algorithms are accepted; "none" and HS* are always rejected.
func isSupportedAlg(alg string) bool {
	switch alg {
	case "ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512":
		return true
	default:
		return false
	}
}

// AuthenticateRequest extracts and verifies a JWT from an HTTP request.
//
// Token lookup order:
//  1. Authorization: Bearer <token>
//  2. Cookie named by CookieName (default "__session")
//
// Always returns AuthState; authentication failures are captured in Reason rather than
// returned as an error, so the caller can serve a 401 without a second error check.
func (c *Client) AuthenticateRequest(ctx context.Context, r *http.Request) AuthState {
	tokenStr, _ := extractToken(r, c.opts.CookieName)
	if tokenStr == "" {
		return AuthState{Authenticated: false, Reason: "no_token"}
	}

	claims, err := c.VerifyAccessToken(ctx, tokenStr)
	if err != nil {
		var sdkErr *SDKError
		reason := "token_invalid"
		if e, ok := err.(*SDKError); ok {
			sdkErr = e
			reason = sdkErr.Code
		}
		return AuthState{Authenticated: false, Reason: reason}
	}
	return AuthState{Authenticated: true, Claims: claims}
}

// extractToken extracts a raw JWT string from the Authorization header or a named cookie.
// Returns (token, source) where source is "header" or "cookie".
func extractToken(r *http.Request, cookieName string) (string, string) {
	if auth := r.Header.Get("Authorization"); auth != "" {
		const prefix = "Bearer "
		if strings.HasPrefix(auth, prefix) {
			tok := strings.TrimSpace(auth[len(prefix):])
			if tok != "" {
				return tok, "header"
			}
		}
	}
	if cookie, err := r.Cookie(cookieName); err == nil && cookie.Value != "" {
		return cookie.Value, "cookie"
	}
	return "", ""
}

// Middleware returns a standard net/http handler middleware.
// On success, *Claims is stored in the request context (retrieve with ClaimsFromContext).
// On failure, onUnauthorized is called (defaults to a plain 401 response).
//
// Example:
//
//	mux.Handle("/api/", client.Middleware(apiHandler, nil))
func (c *Client) Middleware(next http.Handler, onUnauthorized func(http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := c.AuthenticateRequest(r.Context(), r)
		if !state.Authenticated {
			if onUnauthorized != nil {
				onUnauthorized(w, r)
			} else {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
			}
			return
		}
		ctx := context.WithValue(r.Context(), claimsContextKey{}, state.Claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ClaimsFromContext retrieves *Claims injected by Middleware.
// Returns nil if the context has no claims (e.g., the request didn't pass through Middleware).
func ClaimsFromContext(ctx context.Context) *Claims {
	v, _ := ctx.Value(claimsContextKey{}).(*Claims)
	return v
}

// claimsContextKey is a private context key type to avoid collisions with other packages.
type claimsContextKey struct{}
