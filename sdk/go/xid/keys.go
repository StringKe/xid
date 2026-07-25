// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT
//
// JWK parsing: EC (ES256) and RSA (RS256) public key support.

package xid

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"math/big"
)

// parsedKey is a decoded public key with associated metadata for JWT verification.
type parsedKey struct {
	Kid string
	Alg string // "ES256" | "RS256" | ...
	Key any    // *ecdsa.PublicKey or *rsa.PublicKey
}

// parseJWK converts a raw JWK JSON object to a parsedKey.
// Supports EC (P-256 / ES256) and RSA (RS256).
func parseJWK(k jwk) (parsedKey, error) {
	switch k.Kty {
	case "EC":
		return parseECKey(k)
	case "RSA":
		return parseRSAKey(k)
	default:
		return parsedKey{}, fmt.Errorf("xid: unsupported kty %q", k.Kty)
	}
}

// parseECKey decodes an EC public key from JWK fields.
// Supports P-256 (ES256), P-384 (ES384), and P-521 (ES512).
func parseECKey(k jwk) (parsedKey, error) {
	var curve elliptic.Curve
	switch k.Crv {
	case "P-256":
		curve = elliptic.P256()
	case "P-384":
		curve = elliptic.P384()
	case "P-521":
		curve = elliptic.P521()
	default:
		return parsedKey{}, fmt.Errorf("xid: unsupported EC curve %q", k.Crv)
	}

	xBytes, err := base64URLDecodeField(k.X, "x")
	if err != nil {
		return parsedKey{}, err
	}
	yBytes, err := base64URLDecodeField(k.Y, "y")
	if err != nil {
		return parsedKey{}, err
	}
	pub := &ecdsa.PublicKey{
		Curve: curve,
		X:     new(big.Int).SetBytes(xBytes),
		Y:     new(big.Int).SetBytes(yBytes),
	}
	alg := k.Alg
	if alg == "" {
		alg = "ES256"
	}
	return parsedKey{Kid: k.Kid, Alg: alg, Key: pub}, nil
}

// parseRSAKey decodes an RSA public key from JWK fields.
func parseRSAKey(k jwk) (parsedKey, error) {
	nBytes, err := base64URLDecodeField(k.N, "n")
	if err != nil {
		return parsedKey{}, err
	}
	eBytes, err := base64URLDecodeField(k.E, "e")
	if err != nil {
		return parsedKey{}, err
	}
	eBig := new(big.Int).SetBytes(eBytes)
	pub := &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(eBig.Int64()),
	}
	alg := k.Alg
	if alg == "" {
		alg = "RS256"
	}
	return parsedKey{Kid: k.Kid, Alg: alg, Key: pub}, nil
}

// base64URLDecodeField decodes a base64url (no-padding) JWK field value.
func base64URLDecodeField(s, field string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("xid: decode JWK field %q: %w", field, err)
	}
	return b, nil
}
