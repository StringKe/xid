// OIDC RP-initiated logout via POST /end_session

namespace Xid.Windows;

internal static class EndSessionClient
{
    internal static async Task EndSessionAsync(
        HttpClient http,
        Uri endSessionEndpoint,
        string idTokenHint,
        string? postLogoutRedirectUri = null,
        CancellationToken ct = default)
    {
        var form = new Dictionary<string, string>
        {
            ["id_token_hint"] = idTokenHint,
        };
        if (!string.IsNullOrEmpty(postLogoutRedirectUri))
            form["post_logout_redirect_uri"] = postLogoutRedirectUri;

        using var content = new FormUrlEncodedContent(form);
        using var request = new HttpRequestMessage(HttpMethod.Post, endSessionEndpoint) { Content = content };

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new XidException("无法访问 /end_session 端点。", "end_session_failed", ex);
        }

        if (!response.IsSuccessStatusCode)
            throw new XidException(
                $"/end_session 返回 HTTP {(int)response.StatusCode}。",
                "end_session_failed");
    }
}