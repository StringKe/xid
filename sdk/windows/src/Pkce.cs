// Pkce.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// PKCE code_verifier / code_challenge 生成 (RFC 7636)。
// 使用 System.Security.Cryptography:RandomNumberGenerator + SHA256。
// XID 服务端强制 S256,拒绝 plain。

using System.Security.Cryptography;
using System.Text;

namespace Xid.Windows;

/// <summary>
/// PKCE S256 参数对。
/// </summary>
internal sealed class PkceParameters
{
    /// <summary>随机生成的 code_verifier (Base64URL 无填充,43-128 字符)。</summary>
    public string Verifier { get; }

    /// <summary>BASE64URL(SHA256(ASCII(code_verifier)))。</summary>
    public string Challenge { get; }

    /// <summary>固定为 "S256"。XID 服务端拒绝 plain。</summary>
    public string Method => "S256";

    private PkceParameters(string verifier, string challenge)
    {
        Verifier = verifier;
        Challenge = challenge;
    }

    /// <summary>
    /// 生成新的 PKCE 参数对。
    /// 使用 <see cref="RandomNumberGenerator.GetBytes"/> 产生密码学安全随机字节。
    /// </summary>
    public static PkceParameters Generate()
    {
        // 32 字节 -> 43 字符 Base64URL,满足 RFC 7636 最小长度要求
        byte[] randomBytes = RandomNumberGenerator.GetBytes(32);
        string verifier = Base64UrlEncode(randomBytes);

        // code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
        byte[] verifierBytes = Encoding.ASCII.GetBytes(verifier);
        byte[] challengeBytes = SHA256.HashData(verifierBytes);
        string challenge = Base64UrlEncode(challengeBytes);

        return new PkceParameters(verifier, challenge);
    }

    /// <summary>
    /// Base64URL 编码 (无填充,RFC 4648 Section 5)。
    /// </summary>
    private static string Base64UrlEncode(byte[] data)
    {
        return Convert.ToBase64String(data)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }
}
