import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;

/// 单条已解析的 JWKS 公钥(当前仅 ES256 / P-256)。
class JwksPublicKey {
  final String kid;
  final EcPublicKey publicKey;

  const JwksPublicKey({required this.kid, required this.publicKey});
}

/// JWKS 内存缓存,TTL 默认 1 小时(与服务端 KV 对齐)。
class JwksCache {
  final String jwksUri;
  final http.Client httpClient;
  final Duration ttl;

  Map<String, JwksPublicKey> _keys = {};
  DateTime? _fetchedAt;

  JwksCache({
    required this.jwksUri,
    http.Client? httpClient,
    this.ttl = const Duration(hours: 1),
  }) : httpClient = httpClient ?? http.Client();

  Future<JwksPublicKey> getKey(String kid) async {
    if (_fetchedAt != null &&
        DateTime.now().difference(_fetchedAt!) < ttl &&
        _keys.containsKey(kid)) {
      return _keys[kid]!;
    }

    await _refresh();

    final key = _keys[kid];
    if (key == null) {
      throw StateError('JWKS key not found for kid=$kid');
    }
    return key;
  }

  Future<void> _refresh() async {
    final resp = await httpClient.get(Uri.parse(jwksUri));
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError('JWKS fetch failed: HTTP ${resp.statusCode}');
    }

    final doc = jsonDecode(resp.body) as Map<String, dynamic>;
    final keys = (doc['keys'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>();

    final parsed = <String, JwksPublicKey>{};
    for (final raw in keys) {
      final kid = raw['kid'] as String?;
      final kty = raw['kty'] as String?;
      if (kid == null || kty != 'EC') continue;

      final crv = raw['crv'] as String? ?? 'P-256';
      if (crv != 'P-256') continue;

      final xRaw = raw['x'] as String?;
      final yRaw = raw['y'] as String?;
      if (xRaw == null || yRaw == null) continue;

      final x = _base64UrlDecode(xRaw);
      final y = _base64UrlDecode(yRaw);
      parsed[kid] = JwksPublicKey(
        kid: kid,
        publicKey: EcPublicKey(
          type: KeyPairType.p256,
          x: x,
          y: y,
        ),
      );
    }

    if (parsed.isEmpty) {
      throw StateError('JWKS contains no usable EC P-256 keys');
    }

    _keys = parsed;
    _fetchedAt = DateTime.now();
  }

  static List<int> _base64UrlDecode(String input) {
    var normalized = input.replaceAll('-', '+').replaceAll('_', '/');
    final pad = (4 - normalized.length % 4) % 4;
    normalized += '=' * pad;
    return base64Decode(normalized);
  }
}
