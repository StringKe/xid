// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT
//
// Webhook HMAC-SHA256 verification (svix-compatible header format).
// See docs/design/06-developer-experience.md.

package xid

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// WebhookEvent holds the verified webhook payload.
type WebhookEvent struct {
	// ID corresponds to the svix-id header value.
	ID string

	// Timestamp is the parsed svix-timestamp Unix epoch value.
	Timestamp time.Time

	// Body is the raw request body bytes (already read; safe to JSON-decode).
	Body []byte
}

const (
	// webhookTimestampTolerance is the replay-prevention window: 5 minutes.
	webhookTimestampTolerance = 5 * time.Minute

	// webhookBodyLimit prevents excessive memory use from oversized payloads.
	webhookBodyLimit = 1 << 20 // 1 MiB

	// whsecPrefix is the svix webhook secret prefix.
	whsecPrefix = "whsec_"
)

// VerifyWebhook verifies the authenticity of an XID webhook request.
//
// Expected headers (svix format):
//
//	svix-id:        <unique event ID>
//	svix-timestamp: <Unix epoch seconds>
//	svix-signature: v1,<base64(HMAC-SHA256)> [v1,<base64> ...]
//
// Verification steps:
//  1. Check all three required headers are present.
//  2. Parse and validate svix-timestamp is within ±5 minutes (replay prevention).
//  3. Read the request body.
//  4. Construct signed content: "<svix-id>.<svix-timestamp>.<body>".
//  5. Compute HMAC-SHA256 using the decoded webhook secret.
//  6. Constant-time compare against each v1 signature in svix-signature.
//
// Returns *WebhookEvent on success or a descriptive *SDKError on failure.
func (c *Client) VerifyWebhook(r *http.Request) (*WebhookEvent, error) {
	return c.verifyWebhookAt(r, time.Now())
}

// verifyWebhookAt is the internal implementation with an injectable clock for testing.
func (c *Client) verifyWebhookAt(r *http.Request, now time.Time) (*WebhookEvent, error) {
	if c.opts.WebhookSecret == "" {
		return nil, &SDKError{Code: ErrCodeConfigInvalid, Message: "WebhookSecret is not configured"}
	}

	secretBytes, err := decodeWebhookSecret(c.opts.WebhookSecret)
	if err != nil {
		return nil, &SDKError{Code: ErrCodeConfigInvalid, Message: "invalid WebhookSecret", Cause: err}
	}

	msgID := r.Header.Get("svix-id")
	msgTimestampStr := r.Header.Get("svix-timestamp")
	msgSignatureHeader := r.Header.Get("svix-signature")

	if msgID == "" || msgTimestampStr == "" || msgSignatureHeader == "" {
		return nil, &SDKError{Code: ErrCodeWebhookInvalid, Message: "missing required svix headers (svix-id, svix-timestamp, svix-signature)"}
	}

	tsSec, err := strconv.ParseInt(msgTimestampStr, 10, 64)
	if err != nil {
		return nil, &SDKError{Code: ErrCodeWebhookInvalid, Message: fmt.Sprintf("invalid svix-timestamp %q", msgTimestampStr)}
	}
	msgTime := time.Unix(tsSec, 0)
	diff := now.Sub(msgTime)
	if diff < 0 {
		diff = -diff
	}
	if diff > webhookTimestampTolerance {
		return nil, &SDKError{Code: ErrCodeWebhookInvalid, Message: fmt.Sprintf("svix-timestamp is outside the 5-minute tolerance window (diff=%s)", diff)}
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, webhookBodyLimit))
	if err != nil {
		return nil, fmt.Errorf("xid: read webhook body: %w", err)
	}

	// Signed content format: "<id>.<timestamp>.<body>"
	signedContent := msgID + "." + msgTimestampStr + "." + string(body)
	expectedMAC := computeHMACSHA256(secretBytes, signedContent)

	if !matchAnyWebhookSignature(msgSignatureHeader, expectedMAC) {
		return nil, &SDKError{Code: ErrCodeWebhookInvalid, Message: "webhook signature verification failed"}
	}

	return &WebhookEvent{
		ID:        msgID,
		Timestamp: msgTime,
		Body:      body,
	}, nil
}

// decodeWebhookSecret strips the "whsec_" prefix (if present) and base64-decodes the secret.
// The svix secret format is "whsec_<base64-standard-encoded>".
func decodeWebhookSecret(secret string) ([]byte, error) {
	raw := secret
	if strings.HasPrefix(secret, whsecPrefix) {
		raw = secret[len(whsecPrefix):]
	}
	// Standard base64 with padding; svix uses standard (not URL-safe) encoding.
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		// Also accept unpadded standard base64.
		decoded, err = base64.RawStdEncoding.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("base64 decode failed: %w", err)
		}
	}
	return decoded, nil
}

// computeHMACSHA256 computes HMAC-SHA256 of content using the provided key bytes.
func computeHMACSHA256(key []byte, content string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(content))
	return mac.Sum(nil)
}

// matchAnyWebhookSignature checks whether any v1 signature in the svix-signature header
// matches the expected MAC using constant-time comparison.
//
// svix-signature header format: "v1,<base64> v1,<base64>" (space-separated, multiple allowed
// to support key rotation overlap).
func matchAnyWebhookSignature(header string, expectedMAC []byte) bool {
	for _, part := range strings.Fields(header) {
		idx := strings.Index(part, ",")
		if idx < 0 {
			continue
		}
		if part[:idx] != "v1" {
			continue
		}
		sigB64 := part[idx+1:]
		// Decode provided signature bytes for constant-time byte comparison.
		sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
		if err != nil {
			// Try without padding.
			sigBytes, err = base64.RawStdEncoding.DecodeString(sigB64)
			if err != nil {
				continue
			}
		}
		// hmac.Equal is constant-time.
		if hmac.Equal(sigBytes, expectedMAC) {
			return true
		}
	}
	return false
}
