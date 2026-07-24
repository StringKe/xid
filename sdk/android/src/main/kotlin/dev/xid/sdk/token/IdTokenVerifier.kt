/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 *
 * ID token (JWT) signature verification using nimbus-jose-jwt.
 *
 * Security contract:
 * - alg whitelist: ES256 required, RS256 accepted for compatibility; "none" and alg confusion rejected.
 * - exp/iat validation with configurable clock tolerance (default 60s, aligned with @xid-kit/backend).
 * - iss and aud mandatory checks when provided.
 * - nonce validation when provided.
 * - JWKS fetched from discovery.jwksUri, cached in memory with TTL (default 3600s).
 */

package dev.xid.sdk.token

import com.nimbusds.jose.JOSEException
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.source.ImmutableJWKSet
import com.nimbusds.jose.proc.BadJOSEException
import com.nimbusds.jose.proc.JWSVerificationKeySelector
import com.nimbusds.jose.proc.SecurityContext
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.nimbusds.jwt.proc.BadJWTException
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier
import com.nimbusds.jwt.proc.DefaultJWTProcessor
import dev.xid.sdk.model.XidException
import okhttp3.OkHttpClient
import okhttp3.Request
import java.text.ParseException
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * JWKS cache entry: raw JSON string + fetch timestamp (ms).
 */
private data class JwksCacheEntry(val jwksJson: String, val fetchedAt: Long)

/**
 * Verifies OIDC ID tokens (signed JWTs) using nimbus-jose-jwt.
 *
 * Thread-safe: the JWKS cache is guarded by [synchronized].
 *
 * @param jwksUri       JWKS endpoint URL from OIDC discovery.
 * @param issuer        Expected iss claim. Mandatory.
 * @param clientId      Expected aud claim (client ID). Mandatory.
 * @param httpClient    OkHttpClient instance (shared with TokenManager).
 * @param jwksCacheTtlMs JWKS in-memory cache TTL in milliseconds (default 3600000 = 1h).
 * @param clockToleranceSec Clock skew tolerance in seconds (default 60, aligned with backend).
 */
internal class IdTokenVerifier(
    private val jwksUri: String,
    private val issuer: String,
    private val clientId: String,
    private val httpClient: OkHttpClient,
    private val jwksCacheTtlMs: Long = 3_600_000L,
    private val clockToleranceSec: Int = 60,
) {
    private var cache: JwksCacheEntry? = null

    // Allowed signing algorithms: ES256 primary, RS256 for legacy compatibility.
    // "none" is never in this list; alg confusion is blocked by using JWSVerificationKeySelector.
    private val allowedAlgorithms = setOf(JWSAlgorithm.ES256, JWSAlgorithm.RS256)

    /**
     * Fetches JWKS from [jwksUri], returns cached value if still valid.
     */
    @Synchronized
    private fun getJwks(): JWKSet {
        val now = System.currentTimeMillis()
        val cached = cache
        if (cached != null && (now - cached.fetchedAt) < jwksCacheTtlMs) {
            return JWKSet.parse(cached.jwksJson)
        }

        val req = Request.Builder()
            .url(jwksUri)
            .get()
            .header("Accept", "application/json")
            .build()

        val body = try {
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    throw XidException.TokenValidationFailed("JWKS fetch failed: HTTP ${resp.code}")
                }
                resp.body?.string()
                    ?: throw XidException.TokenValidationFailed("JWKS response body was empty")
            }
        } catch (e: XidException) {
            throw e
        } catch (e: Exception) {
            throw XidException.TokenValidationFailed("JWKS network error: ${e.message}")
        }

        val parsed = try {
            JWKSet.parse(body)
        } catch (e: ParseException) {
            throw XidException.TokenValidationFailed("JWKS parse failed: ${e.message}")
        }

        cache = JwksCacheEntry(jwksJson = body, fetchedAt = now)
        return parsed
    }

    /**
     * Verifies an ID token JWT and returns the claims.
     *
     * @param idToken  Raw JWT string.
     * @param nonce    Expected nonce claim (optional; if provided, must match).
     * @return Verified [JWTClaimsSet].
     * @throws [XidException.TokenValidationFailed] on any verification failure.
     */
    fun verify(idToken: String, nonce: String? = null): JWTClaimsSet {
        val signedJwt = try {
            SignedJWT.parse(idToken)
        } catch (e: ParseException) {
            throw XidException.TokenValidationFailed("ID token is not a valid JWT: ${e.message}")
        }

        // Reject any algorithm not in the whitelist (blocks "none" and unexpected algs).
        val alg = signedJwt.header.algorithm
        if (alg !in allowedAlgorithms) {
            throw XidException.TokenValidationFailed(
                "ID token algorithm '${alg.name}' is not allowed (only ES256, RS256)"
            )
        }

        val jwks = getJwks()
        val keySelector = JWSVerificationKeySelector<SecurityContext>(alg, ImmutableJWKSet(jwks))

        val processor = DefaultJWTProcessor<SecurityContext>()
        processor.jwsKeySelector = keySelector

        // Claims verifier: mandatory iss/sub/aud/exp/iat; optional nonce.
        val exactMatchClaims = JWTClaimsSet.Builder()
            .issuer(issuer)
            .build()
        val requiredClaims = mutableSetOf("iss", "sub", "aud", "exp", "iat")
        if (nonce != null) requiredClaims += "nonce"

        val claimsVerifier = object : DefaultJWTClaimsVerifier<SecurityContext>(
            exactMatchClaims,
            requiredClaims,
        ) {
            override fun verify(claimsSet: JWTClaimsSet, context: SecurityContext?) {
                super.verify(claimsSet, context)

                // aud must contain clientId
                if (clientId !in claimsSet.audience) {
                    throw BadJWTException("ID token audience does not include clientId=$clientId")
                }

                // exp/iat with clock tolerance
                val nowMs = System.currentTimeMillis()
                val exp = claimsSet.expirationTime?.time
                    ?: throw BadJWTException("ID token missing exp")
                val iat = claimsSet.issueTime?.time
                    ?: throw BadJWTException("ID token missing iat")
                val toleranceMs = clockToleranceSec * 1000L

                if (nowMs - toleranceMs > exp) {
                    throw BadJWTException("ID token is expired")
                }
                if (iat - toleranceMs > nowMs) {
                    throw BadJWTException("ID token issued in the future")
                }

                // nonce validation
                if (nonce != null && claimsSet.getStringClaim("nonce") != nonce) {
                    throw BadJWTException("ID token nonce mismatch")
                }
            }
        }
        processor.jwtClaimsSetVerifier = claimsVerifier

        return try {
            processor.process(signedJwt, null)
        } catch (e: BadJOSEException) {
            throw XidException.TokenValidationFailed("ID token verification failed: ${e.message}")
        } catch (e: BadJWTException) {
            throw XidException.TokenValidationFailed("ID token claims invalid: ${e.message}")
        } catch (e: JOSEException) {
            throw XidException.TokenValidationFailed("ID token JOSE error: ${e.message}")
        }
    }
}
