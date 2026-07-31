/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 */

package dev.xid.sdk.token

import dev.xid.sdk.model.OidcDiscovery
import dev.xid.sdk.model.TokenErrorResponse
import dev.xid.sdk.model.TokenResponse
import dev.xid.sdk.model.XidException
import dev.xid.sdk.model.XidSession
import dev.xid.sdk.model.XidUser
import dev.xid.sdk.storage.StorageKeys
import dev.xid.sdk.storage.TokenStorageAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Handles token exchange, session reconstruction, and sign-out.
 *
 * Security guarantees:
 * - ID tokens are fully verified (signature + exp/iat/iss/aud/nonce) via [IdTokenVerifier].
 * - alg whitelist enforced: ES256 required, RS256 accepted; "none" and alg confusion rejected.
 * - Tokens are persisted exclusively in EncryptedSharedPreferences (AES-256-GCM via Keystore).
 * - Token endpoint POST carries Cache-Control: no-store per RFC 6749.
 */
internal class TokenManager(
    private val storage: TokenStorageAdapter,
    private val discovery: OidcDiscovery? = null,
    private val clientId: String? = null,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        // Certificate pinning: enable in production builds via a CertificatePinner.
        .build()

    // ---------------------------------------------------------------------------
    // Code Exchange
    // ---------------------------------------------------------------------------

    /**
     * Exchanges an authorization code for a token set.
     *
     * @param code          Authorization code from the callback URL.
     * @param codeVerifier  PKCE code_verifier corresponding to the code_challenge in /authorize.
     * @param clientId      OAuth2 client ID.
     * @param redirectUri   redirect_uri matching the value sent to /authorize.
     * @param nonce         Optional nonce value that was sent in /authorize; verified against id_token.
     * @return [XidSession] after persisting tokens.
     */
    suspend fun exchangeCode(
        code: String,
        codeVerifier: String,
        clientId: String,
        redirectUri: String,
        nonce: String? = null,
    ): XidSession = withContext(Dispatchers.IO) {
        val discovery = discovery
            ?: throw XidException.DiscoveryFailed("token exchange requires discovery")
        val body = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("redirect_uri", redirectUri)
            .add("client_id", clientId)
            .add("code_verifier", codeVerifier)
            .build()

        val tokenResponse = postToTokenEndpoint(body, discovery)
        persistAndBuildSession(
            tokenResponse,
            discovery = discovery,
            clientId = clientId,
            nonce = nonce,
        )
    }

    // ---------------------------------------------------------------------------
    // Session Reconstruction
    // ---------------------------------------------------------------------------

    /**
     * Reconstructs a [XidSession] from persisted EncryptedSharedPreferences.
     *
     * Does NOT perform JWT re-verification on load (signature was verified at code exchange time).
     * The access token expiry is checked by the caller before using the session.
     *
     * @return Stored [XidSession] or null if no session exists.
     */
    suspend fun loadSession(): XidSession? {
        val accessToken = storage.get(StorageKeys.ACCESS_TOKEN) ?: return null
        val idToken = storage.get(StorageKeys.ID_TOKEN) ?: return null
        val expiresAt = storage.get(StorageKeys.ACCESS_TOKEN_EXPIRES_AT)?.toLongOrNull() ?: 0L

        val user = parseUserFromIdTokenPayload(idToken) ?: return null

        return XidSession(
            user = user,
            accessToken = accessToken,
            accessTokenExpiresAt = expiresAt,
            refreshToken = null,
            idToken = idToken,
        )
    }

    /**
     * Clears all persisted tokens. Called on sign-out.
     */
    suspend fun clearAll() {
        storage.clear(StorageKeys.ACCESS_TOKEN)
        storage.clear(StorageKeys.ACCESS_TOKEN_EXPIRES_AT)
        storage.clear(StorageKeys.REFRESH_TOKEN)
        storage.clear(StorageKeys.ID_TOKEN)
        storage.clear(StorageKeys.PKCE_STATE)
        storage.clear(StorageKeys.PKCE_VERIFIER)
        storage.clear(StorageKeys.OIDC_NONCE)
    }

    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------

    private fun postToTokenEndpoint(body: FormBody, discovery: OidcDiscovery): TokenResponse {
        val request = Request.Builder()
            .url(discovery.tokenEndpoint)
            .post(body)
            .header("Accept", "application/json")
            // RFC 6749: token endpoint response must not be cached.
            .header("Cache-Control", "no-store")
            .build()

        val responseBody = httpClient.newCall(request).execute().use { response ->
            val bodyStr = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                val errorResp = runCatching {
                    json.decodeFromString<TokenErrorResponse>(bodyStr)
                }.getOrNull()
                throw XidException.TokenExchangeFailed(
                    errorCode = errorResp?.error ?: "http_${response.code}",
                    description = errorResp?.errorDescription ?: bodyStr.take(200),
                )
            }
            bodyStr
        }

        return runCatching { json.decodeFromString<TokenResponse>(responseBody) }
            .getOrElse { e -> throw XidException.NetworkError("Failed to parse token response", e) }
    }

    private suspend fun persistAndBuildSession(
        tokenResponse: TokenResponse,
        discovery: OidcDiscovery,
        clientId: String,
        nonce: String?,
    ): XidSession {
        val idToken = tokenResponse.idToken
            ?: throw XidException.TokenValidationFailed("Token response missing id_token")

        // Full JWT verification: signature (ES256/RS256), exp/iat (60s tolerance), iss, aud, nonce.
        val verifier = IdTokenVerifier(
            jwksUri = discovery.jwksUri,
            issuer = discovery.issuer,
            clientId = clientId,
            httpClient = httpClient,
        )
        val claims = verifier.verify(idToken, nonce)

        val expiresAt = System.currentTimeMillis() + (tokenResponse.expiresIn * 1000L)

        storage.set(StorageKeys.ACCESS_TOKEN, tokenResponse.accessToken)
        storage.set(StorageKeys.ACCESS_TOKEN_EXPIRES_AT, expiresAt.toString())
        storage.set(StorageKeys.ID_TOKEN, idToken)
        storage.clear(StorageKeys.REFRESH_TOKEN)

        // Clear PKCE ephemeral data after successful exchange.
        storage.clear(StorageKeys.PKCE_STATE)
        storage.clear(StorageKeys.PKCE_VERIFIER)
        storage.clear(StorageKeys.OIDC_NONCE)

        val user = XidUser(
            sub = claims.subject
                ?: throw XidException.TokenValidationFailed("ID token missing sub"),
            email = claims.getStringClaim("email"),
            emailVerified = claims.getBooleanClaim("email_verified") ?: false,
            name = claims.getStringClaim("name"),
            picture = claims.getStringClaim("picture"),
            organization = claims.getStringClaim("org_id"),
        )

        return XidSession(
            user = user,
            accessToken = tokenResponse.accessToken,
            accessTokenExpiresAt = expiresAt,
            refreshToken = null,
            idToken = idToken,
        )
    }

    /**
     * Extracts basic user claims from the ID token payload without signature verification.
     *
     * This is used ONLY when reconstructing a session from storage (loadSession), where the
     * signature was already verified at code exchange time. The payload decode here is
     * intentionally unverified -- it reads only non-security-sensitive display fields.
     */
    private fun parseUserFromIdTokenPayload(idToken: String): XidUser? {
        return runCatching {
            val parts = idToken.split(".")
            if (parts.size != 3) return null

            val payload = android.util.Base64.decode(
                parts[1].padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, '='),
                android.util.Base64.URL_SAFE,
            )
            val jsonStr = String(payload, Charsets.UTF_8)
            val jsonObj = json.parseToJsonElement(jsonStr).let {
                it as? kotlinx.serialization.json.JsonObject
            } ?: return null

            fun field(key: String) =
                (jsonObj[key] as? kotlinx.serialization.json.JsonPrimitive)?.content

            XidUser(
                sub = field("sub") ?: return null,
                email = field("email"),
                emailVerified = field("email_verified")?.toBoolean() ?: false,
                name = field("name"),
                picture = field("picture"),
                organization = field("org_id"),
            )
        }.getOrNull()
    }
}
