// Copyright 2024 XID Contributors
// SPDX-License-Identifier: MIT
//
// SDK error types.

package xid

import "fmt"

// ErrorCode classifies SDK errors for programmatic handling.
type ErrorCode = string

const (
	ErrCodeTokenExpired    ErrorCode = "token_expired"
	ErrCodeTokenInvalid    ErrorCode = "token_invalid"
	ErrCodeTokenMissing    ErrorCode = "token_missing"
	ErrCodeJWKSFetchFailed ErrorCode = "jwks_fetch_failed"
	ErrCodeWebhookInvalid  ErrorCode = "webhook_invalid"
	ErrCodeConfigInvalid   ErrorCode = "config_invalid"
)

// SDKError is the structured error type returned by all public SDK functions.
// Inspect Code to branch on the failure reason without string matching.
type SDKError struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *SDKError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("xid[%s]: %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("xid[%s]: %s", e.Code, e.Message)
}

func (e *SDKError) Unwrap() error { return e.Cause }
