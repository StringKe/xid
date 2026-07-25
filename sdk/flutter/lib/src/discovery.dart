import 'dart:convert';
import 'package:http/http.dart' as http;
import 'errors.dart';

/// OIDC Discovery 文档(RFC 8414 + OpenID Discovery 1.0)。
///
/// 缓存一个 in-process 实例即可;生产中可加 TTL 重新 fetch。
class OidcDiscovery {
  final String issuer;
  final String authorizationEndpoint;
  final String tokenEndpoint;
  final String jwksUri;
  final String? endSessionEndpoint;
  final String? introspectionEndpoint;
  final String? revocationEndpoint;
  final List<String> responseTypesSupported;
  final List<String> codeChallengeMethodsSupported;

  OidcDiscovery._({
    required this.issuer,
    required this.authorizationEndpoint,
    required this.tokenEndpoint,
    required this.jwksUri,
    this.endSessionEndpoint,
    this.introspectionEndpoint,
    this.revocationEndpoint,
    required this.responseTypesSupported,
    required this.codeChallengeMethodsSupported,
  });

  factory OidcDiscovery.fromJson(Map<String, dynamic> json) {
    return OidcDiscovery._(
      issuer: json['issuer'] as String,
      authorizationEndpoint: json['authorization_endpoint'] as String,
      tokenEndpoint: json['token_endpoint'] as String,
      jwksUri: json['jwks_uri'] as String,
      endSessionEndpoint: json['end_session_endpoint'] as String?,
      introspectionEndpoint: json['introspection_endpoint'] as String?,
      revocationEndpoint: json['revocation_endpoint'] as String?,
      responseTypesSupported: List<String>.from(
          json['response_types_supported'] as List? ?? ['code']),
      codeChallengeMethodsSupported: List<String>.from(
          json['code_challenge_methods_supported'] as List? ?? ['S256']),
    );
  }

  /// 从 discovery URL fetch 并解析。
  static Future<OidcDiscovery> fetch(
    String discoveryUrl, {
    http.Client? client,
  }) async {
    final httpClient = client ?? http.Client();
    try {
      final uri = Uri.parse(discoveryUrl);
      final response = await httpClient.get(
        uri,
        headers: {'Accept': 'application/json'},
      );

      if (response.statusCode != 200) {
        throw XidNetworkException(
          'OIDC discovery 失败: HTTP ${response.statusCode}',
          statusCode: response.statusCode,
        );
      }

      final Map<String, dynamic> json =
          jsonDecode(response.body) as Map<String, dynamic>;
      return OidcDiscovery.fromJson(json);
    } on XidNetworkException {
      rethrow;
    } catch (e) {
      throw XidNetworkException(
        'OIDC discovery 请求异常: $e',
        cause: e,
      );
    }
  }
}
