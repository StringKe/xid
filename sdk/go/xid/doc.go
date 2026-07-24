// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT

// Package xid is the Go server-side SDK for the XID identity platform (https://xid.dev).
//
// Responsibilities (server-side only):
//   - Networkless JWT verification (ES256 primary, RS256 compatible), with local JWKS cache.
//   - HTTP request authentication (extracts token from Authorization header or session cookie).
//   - Webhook signature verification (svix-compatible HMAC-SHA256, 5-minute replay window).
//
// OAuth authorization flows (PKCE, authorization_code, device_code, etc.) are NOT implemented
// here -- those belong in browser or mobile clients.
//
// Quick start:
//
//	client, err := xid.NewClient(xid.ClientOptions{
//	    Issuer:   "https://xid.dev",
//	    Audience: "your-client-id",
//	})
//	if err != nil {
//	    log.Fatal(err)
//	}
//
//	// Authenticate a request
//	state := client.AuthenticateRequest(r.Context(), r)
//	if !state.Authenticated {
//	    http.Error(w, "Unauthorized", http.StatusUnauthorized)
//	    return
//	}
//
//	// Verify a webhook
//	event, err := client.VerifyWebhook(r)
package xid
