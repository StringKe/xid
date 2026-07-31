import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography_flutter/cryptography_flutter.dart';

import 'jwks_cache.dart';

/// ID token 验签选项。
class IdTokenVerifyOptions {
  final String issuer;
  final String clientId;
  final String jwksUri;
  final String? expectedNonce;
  final Duration clockSkew;

  const IdTokenVerifyOptions({
    required this.issuer,
    required this.clientId,
    required this.jwksUri,
    this.expectedNonce,
    this.clockSkew = const Duration(seconds: 60),
  });
}

/// 使用 JWKS 对 ID token 做 ES256 验签并校验 iss/aud/exp。
class IdTokenVerifier {
  final JwksCache _cache;
  final Ecdsa _algorithm =
      FlutterCryptography.defaultInstance.ecdsaP256(Sha256());

  IdTokenVerifier({required JwksCache cache}) : _cache = cache;

  Future<Map<String, dynamic>> verify(
    String idToken,
    IdTokenVerifyOptions options,
  ) async {
    final parts = idToken.split('.');
    if (parts.length != 3) {
      throw const FormatException('Invalid JWT format');
    }

    final header = jsonDecode(utf8.decode(_base64UrlDecode(parts[0])))
        as Map<String, dynamic>;
    final alg = header['alg'] as String?;
    final kid = header['kid'] as String?;

    if (alg != 'ES256') {
      throw FormatException('Unsupported ID token algorithm: $alg');
    }
    if (kid == null || kid.isEmpty) {
      throw const FormatException('ID token header missing kid');
    }

    final signedContent = utf8.encode('${parts[0]}.${parts[1]}');
    final signatureBytes = _base64UrlDecode(parts[2]);

    final key = await _cache.getKey(kid);
    final signature = Signature(signatureBytes, publicKey: key.publicKey);
    final valid = await _algorithm.verify(
      signedContent,
      signature: signature,
    );
    if (!valid) {
      throw const FormatException('ID token signature verification failed');
    }

    final payloadJson = utf8.decode(_base64UrlDecode(parts[1]));
    final claims = jsonDecode(payloadJson) as Map<String, dynamic>;

    validateClaims(claims, options);
    return claims;
  }

  static void validateClaims(
      Map<String, dynamic> claims, IdTokenVerifyOptions options) {
    final iss = claims['iss'] as String?;
    if (iss != options.issuer) {
      throw FormatException(
          'Issuer mismatch: expected ${options.issuer}, got $iss');
    }

    final aud = claims['aud'];
    final audiences = <String>{};
    if (aud is String) {
      audiences.add(aud);
    } else if (aud is List) {
      audiences.addAll(aud.whereType<String>());
    }
    if (!audiences.contains(options.clientId)) {
      throw const FormatException('Audience mismatch');
    }

    if (options.expectedNonce != null &&
        claims['nonce'] != options.expectedNonce) {
      throw const FormatException('ID token nonce mismatch');
    }

    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final skew = options.clockSkew.inSeconds;
    final exp = claims['exp'];
    if (exp is! int) {
      throw const FormatException('ID token missing valid exp claim');
    }
    if (now > exp + skew) {
      throw const FormatException('ID token expired');
    }
    final nbf = claims['nbf'];
    if (nbf is int && now + skew < nbf) {
      throw const FormatException('ID token not yet valid');
    }
  }

  static List<int> _base64UrlDecode(String input) {
    var normalized = input.replaceAll('-', '+').replaceAll('_', '/');
    final pad = (4 - normalized.length % 4) % 4;
    normalized += '=' * pad;
    return base64Decode(normalized);
  }
}
