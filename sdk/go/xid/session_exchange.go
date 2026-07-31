package xid

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const sessionTokenPath = "/v1/sessions/token"

// ExchangeSessionToken exchanges a Core opaque browser session for a short-lived JWT.
// The complete Cookie header is forwarded only to the exact same-origin Core endpoint.
func (c *Client) ExchangeSessionToken(
	ctx context.Context,
	incomingRequestURL string,
	cookieHeader string,
	endpoint string,
) (string, error) {
	resolved, err := resolveSessionTokenEndpoint(incomingRequestURL, endpoint)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, resolved.String(), bytes.NewReader(nil))
	if err != nil {
		return "", fmt.Errorf("xid: build session token exchange request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", cookieHeader)

	client := *c.httpClient
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("xid: session token exchange request failed: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("xid: session token exchange returned HTTP %d", res.StatusCode)
	}

	decoder := json.NewDecoder(io.LimitReader(res.Body, 64*1024))
	decoder.DisallowUnknownFields()
	var body struct {
		Token string `json:"token"`
	}
	if err := decoder.Decode(&body); err != nil {
		return "", fmt.Errorf("xid: invalid session token response: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return "", err
	}
	if strings.TrimSpace(body.Token) == "" {
		return "", fmt.Errorf("xid: invalid session token response")
	}
	return body.Token, nil
}

func resolveSessionTokenEndpoint(incomingRequestURL string, endpoint string) (*url.URL, error) {
	incoming, err := url.Parse(incomingRequestURL)
	if err != nil || !validHTTPURL(incoming) || incoming.User != nil {
		return nil, fmt.Errorf("xid: incoming request URL must be an absolute HTTP(S) URL")
	}
	if endpoint == "" {
		endpoint = sessionTokenPath
	}
	target, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("xid: invalid session token endpoint: %w", err)
	}
	resolved := incoming.ResolveReference(target)
	if !validHTTPURL(resolved) ||
		resolved.User != nil ||
		normalizedOrigin(resolved) != normalizedOrigin(incoming) ||
		resolved.EscapedPath() != sessionTokenPath ||
		resolved.RawQuery != "" ||
		resolved.Fragment != "" {
		return nil, fmt.Errorf(
			"xid: session token endpoint must be exact same-origin %s",
			sessionTokenPath,
		)
	}
	return resolved, nil
}

func validHTTPURL(value *url.URL) bool {
	if value == nil || value.Hostname() == "" {
		return false
	}
	scheme := strings.ToLower(value.Scheme)
	return scheme == "http" || scheme == "https"
}

func normalizedOrigin(value *url.URL) string {
	scheme := strings.ToLower(value.Scheme)
	host := strings.ToLower(value.Hostname())
	port := value.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return scheme + "://" + host + ":" + port
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("xid: invalid session token response")
		}
		return fmt.Errorf("xid: invalid session token response: %w", err)
	}
	return nil
}
