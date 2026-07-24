/// XidOptions: SDK 初始化配置,对应 Shared native contract configure(options)。
class XidOptions {
  /// XID issuer URL. 托管版为 https://xid.dev,自托管为部署根域。
  final String issuer;

  /// OAuth2 public client ID. 不含 client_secret。
  final String clientId;

  /// App Link 或 custom scheme 回调 URI,例如
  ///   com.example.app://auth/callback
  ///   https://example.com/auth/callback (App Links)
  final String redirectUri;

  /// 注销后跳转 URI(可选)。
  final String? postLogoutRedirectUri;

  /// 请求 scope 列表,默认包含 openid、profile、email。
  final List<String> scopes;

  /// 附加 authorize 参数(audience、login_hint、prompt 等)。
  final Map<String, String> additionalParameters;

  /// OIDC discovery 端点。默认 [issuer]/.well-known/openid-configuration。
  /// 通常不需要显式设置。
  final String? discoveryUrl;

  const XidOptions({
    required this.issuer,
    required this.clientId,
    required this.redirectUri,
    this.postLogoutRedirectUri,
    this.scopes = const ['openid', 'profile', 'email'],
    this.additionalParameters = const {},
    this.discoveryUrl,
  });

  String get effectiveDiscoveryUrl =>
      discoveryUrl ?? '$issuer/.well-known/openid-configuration';
}
