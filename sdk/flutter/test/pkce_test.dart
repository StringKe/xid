import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xid/src/pkce.dart';

void main() {
  group('Pkce', () {
    test('生成的 code_verifier 长度在 43-128 之间', () {
      final pkce = Pkce.generate();
      expect(pkce.codeVerifier.length, greaterThanOrEqualTo(43));
      expect(pkce.codeVerifier.length, lessThanOrEqualTo(128));
    });

    test('code_verifier 只含合法字符 [A-Za-z0-9-._~]', () {
      final pkce = Pkce.generate();
      final regex = RegExp(r'^[A-Za-z0-9\-._~]+$');
      expect(regex.hasMatch(pkce.codeVerifier), isTrue);
    });

    test('code_challenge = BASE64URL(SHA256(verifier)) 无 padding', () {
      final pkce = Pkce.generate();
      final bytes = utf8.encode(pkce.codeVerifier);
      final digest = sha256.convert(bytes);
      final expected = base64Url.encode(digest.bytes).replaceAll('=', '');
      expect(pkce.codeChallenge, equals(expected));
    });

    test('codeChallengeMethod 始终为 S256', () {
      final pkce = Pkce.generate();
      expect(pkce.codeChallengeMethod, equals('S256'));
    });

    test('两次 generate() 产生不同的 verifier', () {
      final a = Pkce.generate();
      final b = Pkce.generate();
      expect(a.codeVerifier, isNot(equals(b.codeVerifier)));
    });

    test('长度参数边界: length=43', () {
      final pkce = Pkce.generate(length: 43);
      expect(pkce.codeVerifier.length, equals(43));
    });

    test('长度参数边界: length=128', () {
      final pkce = Pkce.generate(length: 128);
      expect(pkce.codeVerifier.length, equals(128));
    });
  });
}
