namespace Xid;

public sealed class SessionTokenExchangeException : XidException
{
    public SessionTokenExchangeException(string message)
        : base(message, "session_token_exchange_error") {}

    public SessionTokenExchangeException(string message, Exception innerException)
        : base(message, "session_token_exchange_error", innerException) {}
}

public sealed record SessionTokenHttpResponse(int StatusCode, string Body);

public delegate Task<SessionTokenHttpResponse> SessionTokenTransport(
    Uri endpoint,
    string cookieHeader,
    CancellationToken cancellationToken);
