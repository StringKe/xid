// IdTokenDecoder.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// id token claims 解码 (不做签名验证,仅解析 payload)。
// 首次登录/换码路径使用 IdTokenVerifier 做 JWKS 验签;本解码器仅用于从持久存储恢复会话。

using System.Text;
using System.Text.Json;

namespace Xid.Windows;

/// <summary>
/// id token payload claims。
/// </summary>
internal sealed class IdTokenClaims
{
    public string Sub { get; init; } = string.Empty;
    public string? Email { get; init; }
    public bool? EmailVerified { get; init; }
    public string? Name { get; init; }
    public string? Picture { get; init; }
    public long Exp { get; init; }
    public string? Iss { get; init; }
}

/// <summary>
/// id token JWT payload 解码器。
/// </summary>
internal static class IdTokenDecoder
{
    /// <summary>
    /// 解码 id token payload。不验证签名。
    /// </summary>
    internal static IdTokenClaims Decode(string idToken)
    {
        string[] parts = idToken.Split('.');
        if (parts.Length != 3)
            throw new TokenExchangeException("id token 格式非法:应为三段 JWT。");

        string payload = parts[1];
        // Base64URL -> Base64 -> bytes -> JSON
        string padded = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=')
            .Replace('-', '+').Replace('_', '/');

        byte[] bytes;
        try { bytes = Convert.FromBase64String(padded); }
        catch (FormatException ex)
        {
            throw new TokenExchangeException("id token payload Base64 解码失败。", inner: ex);
        }

        string json = Encoding.UTF8.GetString(bytes);
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;

        return new IdTokenClaims
        {
            Sub = GetString(root, "sub") ?? string.Empty,
            Email = GetString(root, "email"),
            EmailVerified = GetBool(root, "email_verified"),
            Name = GetString(root, "name"),
            Picture = GetString(root, "picture"),
            Exp = GetLong(root, "exp"),
            Iss = GetString(root, "iss"),
        };
    }

    private static string? GetString(JsonElement el, string key) =>
        el.TryGetProperty(key, out JsonElement v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static bool? GetBool(JsonElement el, string key) =>
        el.TryGetProperty(key, out JsonElement v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean() : null;

    private static long GetLong(JsonElement el, string key) =>
        el.TryGetProperty(key, out JsonElement v) && v.TryGetInt64(out long n) ? n : 0;
}
