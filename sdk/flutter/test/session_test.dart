import 'package:flutter_test/flutter_test.dart';
import 'package:xid/src/session.dart';

void main() {
  group('XidSession', () {
    Map<String, dynamic> makeTokenResponse({
      String? idToken,
      int expiresIn = 3600,
    }) {
      return {
        'access_token': 'at_test',
        'token_type': 'Bearer',
        'expires_in': expiresIn,
        'refresh_token': 'rt_test',
        'scope': 'openid profile email',
        if (idToken != null) 'id_token': idToken,
      };
    }

    test('fromTokenResponse 解析 access_token 和 scope', () async {
      final session = await XidSession.fromTokenResponse(makeTokenResponse());
      expect(session.accessToken, equals('at_test'));
      expect(session.scopes, containsAll(['openid', 'profile', 'email']));
    });

    test('expires_in=3600 -> expiresAt 约 1 小时后', () async {
      final before = DateTime.now();
      final session = await XidSession.fromTokenResponse(makeTokenResponse());
      final after = DateTime.now();
      expect(session.expiresAt.isAfter(before.add(const Duration(seconds: 3599))),
          isTrue);
      expect(session.expiresAt.isBefore(after.add(const Duration(seconds: 3601))),
          isTrue);
    });

    test('isExpired: 已过期 token', () async {
      final resp = makeTokenResponse(expiresIn: -1);
      final session = await XidSession.fromTokenResponse(resp);
      // expires_in=-1 -> expiresAt 在过去
      expect(session.isExpired, isTrue);
    });

    test('needsRefresh: buffer 内视为需要刷新', () async {
      // expires_in=30 -> 30s 后过期,默认 buffer 60s -> 需要刷新
      final resp = makeTokenResponse(expiresIn: 30);
      final session = await XidSession.fromTokenResponse(resp);
      expect(session.needsRefresh(), isTrue);
    });

    test('XidUser.fromClaims 映射 sub -> id', () {
      final user = XidUser.fromClaims({
        'sub': 'user_123',
        'email': 'alice@example.com',
        'email_verified': true,
        'name': 'Alice',
      });
      expect(user.id, equals('user_123'));
      expect(user.email, equals('alice@example.com'));
      expect(user.emailVerified, isTrue);
      expect(user.name, equals('Alice'));
    });

    test('organization 为 null 当 claims 不含 org_id', () async {
      final session = await XidSession.fromTokenResponse(makeTokenResponse());
      expect(session.organization, isNull);
    });
  });
}
