import 'dart:convert';
import 'package:http/http.dart' as http;
import 'errors.dart';

/// /token 端点交互:authorization_code + PKCE 换 token。
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
        final errorJson = jsonDecode(response.body) as Map<String, dynamic>;
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
