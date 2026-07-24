// id token JWKS 验签(Windows 客户端 SDK)

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.IdentityModel.Tokens;

namespace Xid.Windows;

internal static class IdTokenVerifier
{
    private static readonly JwtSecurityTokenHandler Handler = new();
    private static readonly string[] ValidAlgorithms =
    [
        SecurityAlgorithms.EcdsaSha256,
        SecurityAlgorithms.RsaSha256,
        SecurityAlgorithms.RsaSsaPssSha256,
    ];

    static IdTokenVerifier()
    {
        Handler.InboundClaimTypeMap.Clear();
    }

    internal static async Task<IdTokenClaims> VerifyAsync(
        string idToken,
        JwksCache jwksCache,
        string expectedIssuer,
        string expectedAudience,
        string? expectedNonce,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(idToken);

        JwtSecurityToken unvalidated;
        try
        {
            unvalidated = Handler.ReadJwtToken(idToken);
        }
        catch (Exception ex)
        {
            throw new TokenVerificationException($"id token parse failed: {ex.Message}", ex);
        }

        var kid = unvalidated.Header.Kid;
        if (string.IsNullOrEmpty(kid))
            throw new TokenVerificationException("id token header missing kid.");

        var signingKey = await jwksCache.GetKeyAsync(kid, ct).ConfigureAwait(false);
        var parameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = signingKey,
            ValidAlgorithms = ValidAlgorithms,
            ValidateIssuer = true,
            ValidIssuer = expectedIssuer,
            ValidateAudience = true,
            ValidAudience = expectedAudience,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(5),
            RequireSignedTokens = true,
        };

        try
        {
            Handler.ValidateToken(idToken, parameters, out SecurityToken validated);
            if (validated is not JwtSecurityToken jwt)
                throw new TokenVerificationException("validated token is not JWT.");

            if (expectedNonce is not null)
            {
                var nonce = jwt.Claims
                    .FirstOrDefault(c => c.Type == JwtRegisteredClaimNames.Nonce)?.Value;
                if (!string.Equals(nonce, expectedNonce, StringComparison.Ordinal))
                    throw new TokenVerificationException("id token nonce mismatch.");
            }

            return MapClaims(jwt);
        }
        catch (TokenVerificationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new TokenVerificationException($"id token verification failed: {ex.Message}", ex);
        }
    }

    private static IdTokenClaims MapClaims(SecurityToken validated)
    {
        if (validated is not JwtSecurityToken jwt)
            throw new TokenVerificationException("validated token is not JWT.");

        return new IdTokenClaims
        {
            Sub = jwt.Claims.FirstOrDefault(c => c.Type == JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty,
            Email = jwt.Claims.FirstOrDefault(c => c.Type == JwtRegisteredClaimNames.Email)?.Value,
            EmailVerified = ParseBool(jwt.Claims.FirstOrDefault(c => c.Type == "email_verified")?.Value),
            Name = jwt.Claims.FirstOrDefault(c => c.Type == JwtRegisteredClaimNames.Name)?.Value,
            Picture = jwt.Claims.FirstOrDefault(c => c.Type == "picture")?.Value,
            Exp = jwt.ValidTo == DateTime.MinValue ? 0 : new DateTimeOffset(jwt.ValidTo).ToUnixTimeSeconds(),
            Iss = jwt.Issuer,
        };
    }

    private static bool? ParseBool(string? value) =>
        value switch
        {
            "true" => true,
            "false" => false,
            _ => null,
        };
}