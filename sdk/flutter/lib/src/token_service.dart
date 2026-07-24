import 'dart:convert';
import 'package:http/http.dart' as http;
import 'errors.dart';

/// /token 端点交互:authorization_code 换 token + refresh_token 轮换。
class TokenService {
  final http.Client _httpClient;

  TokenService({http.Client? httpClient})
      : _httpClient = httpClient ?? http.Client();

  /// Authorization Code Exchange: code + PKCE verifier -> token set。
  Future<Map<String, dynamic>> exchangeCode({
    required String tokenEndpoint,
    required String clientId,
    required String code,
    required String redirectUri,
    required String codeVerifier,
  }) async {
    final body = {
      'grant_type': 'authorization_code',
      'client_id': clientId,
      'code': code,
      'redirect_uri': redirectUri,
      'code_verifier': codeVerifier,
    };

    return _post(tokenEndpoint, body);
  }

  /// Refresh Token 轮换: 发送旧 refresh_token,返回新 token set。
  ///
  /// XID 采用 rotation + family 策略:旧 token 立即作废,
  /// 重放检测触发整个 family 吊销。
  Future<Map<String, dynamic>> refreshTokens({
    required String tokenEndpoint,
    required String clientId,
    required String refreshToken,
    List<String>? scopes,
  }) async {
    final body = {
      'grant_type': 'refresh_token',
      'client_id': clientId,
      'refresh_token': refreshToken,
      if (scopes != null && scopes.isNotEmpty) 'scope': scopes.join(' '),
    };

    return _post(tokenEndpoint, body);
  }

  /// Token 吊销: 通知服务端吊销 refresh_token / access_token(RFC 7009)。
  Future<void> revokeToken({
    required String revocationEndpoint,
    required String clientId,
    required String token,
    String tokenTypeHint = 'refresh_token',
  }) async {
    final body = {
      'client_id': clientId,
      'token': token,
      'token_type_hint': tokenTypeHint,
    };

    final response = await _httpClient.post(
      Uri.parse(revocationEndpoint),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: _encodeForm(body),
    );

    // RFC 7009: 服务端返回 200 即为成功;即使 token 已过期也应 200。
    if (response.statusCode != 200) {
      throw XidNetworkException(
        'Token 吊销失败: HTTP ${response.statusCode}',
        statusCode: response.statusCode,
      );
    }
  }

  Future<Map<String, dynamic>> _post(
    String endpoint,
    Map<String, String> body,
  ) async {
    final response = await _httpClient.post(
      Uri.parse(endpoint),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: _encodeForm(body),
    );

    if (response.statusCode != 200) {
      // 尝试解析 OAuth2 错误响应
      try {
        final errorJson =
            jsonDecode(response.body) as Map<String, dynamic>;
        throw XidAuthException(
          'Token 端点错误',
          errorCode: errorJson['error'] as String?,
          errorDescription: errorJson['error_description'] as String?,
        );
      } on XidAuthException {
        rethrow;
      } catch (_) {
        throw XidNetworkException(
          'Token 端点 HTTP ${response.statusCode}',
          statusCode: response.statusCode,
        );
      }
    }

    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  static String _encodeForm(Map<String, String> params) {
    return params.entries
        .map((e) =>
            '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
        .join('&');
  }
}
