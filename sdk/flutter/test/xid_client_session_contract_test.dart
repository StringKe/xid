import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:xid/src/errors.dart';
import 'package:xid/src/id_token_verifier.dart';
import 'package:xid/src/token_storage.dart';
import 'package:xid/src/xid_client.dart';
import 'package:xid/src/xid_options.dart';

class SharedStorageState {
  final Map<String, String> values = {};
}

class NamespacedStorageAdapter
    implements TokenStorageAdapter, TokenStorageNamespace {
  final SharedStorageState _state;

  @override
  final String storageNamespace;

  NamespacedStorageAdapter(this._state, this.storageNamespace);

  @override
  Future<void> clear() async => _state.values.clear();

  @override
  Future<void> delete(String key) async => _state.values.remove(key);

  @override
  Future<String?> read(String key) async => _state.values[key];

  @override
  Future<void> write(String key, String value) async {
    _state.values[key] = value;
  }
}

class PkceCallbackClient extends http.BaseClient {
  final bool includeIdToken;
  final List<String> codeVerifiers = [];

  PkceCallbackClient({this.includeIdToken = true});

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path == '/.well-known/openid-configuration') {
      return _jsonResponse({
        'issuer': 'https://issuer.example',
        'authorization_endpoint': 'https://issuer.example/authorize',
        'token_endpoint': 'https://issuer.example/token',
        'jwks_uri': 'https://issuer.example/jwks',
      });
    }
    if (request.url.path == '/token') {
      final body = Uri.splitQueryString((request as http.Request).body);
      codeVerifiers.add(body['code_verifier']!);
      final code = body['code']!;
      return _jsonResponse({
        'access_token': 'access_$code',
        if (includeIdToken)
          'id_token': _unverifiedIdToken(
            nonce: 'nonce_$code',
          ),
        'expires_in': 3600,
      });
    }
    throw StateError('unexpected request: ${request.url}');
  }

  String _unverifiedIdToken({required String nonce}) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final header = _base64Url(
      utf8.encode(jsonEncode({
        // This fixture intentionally stops before platform ECDSA. The callback
        // test covers one-time PKCE state consumption; claim validation is
        // exercised separately below.
        'alg': 'HS256',
        'kid': 'kid_test',
        'typ': 'JWT',
      })),
    );
    final payload = _base64Url(
      utf8.encode(jsonEncode({
        'iss': 'https://issuer.example',
        'sub': 'user_test',
        'aud': 'client_1',
        'exp': now + 3600,
        'iat': now,
        'nonce': nonce,
      })),
    );
    return '$header.$payload.signature';
  }

  String _base64Url(List<int> bytes) =>
      base64Url.encode(bytes).replaceAll('=', '');

  http.StreamedResponse _jsonResponse(Map<String, dynamic> body) {
    return http.StreamedResponse(
      Stream.value(utf8.encode(jsonEncode(body))),
      200,
      headers: {'content-type': 'application/json'},
    );
  }
}

Future<void> configureClient(
  XidClient client,
  TokenStorageAdapter storage,
) {
  return client.configure(
    const XidOptions(
      issuer: 'https://issuer.example',
      clientId: 'client_1',
      redirectUri: 'com.example.app://auth/callback',
    ),
    storageAdapter: storage,
  );
}

void main() {
  test('configure 拒绝没有 DPoP 支持的 offline_access', () async {
    final client = XidClient();
    await expectLater(
      client.configure(
        const XidOptions(
          issuer: 'https://issuer.example',
          clientId: 'client_1',
          redirectUri: 'com.example.app://auth/callback',
          scopes: ['openid', 'offline_access'],
        ),
        storageAdapter: InMemoryStorageAdapter(),
      ),
      throwsA(isA<XidConfigException>()),
    );
  });

  test('过期 session 被清除且不发 refresh token 请求', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = PkceCallbackClient();
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);
    await SessionStore(storage).saveSession(XidSessionData(
      accessToken: 'access_old',
      refreshToken: 'refresh_old',
      expiresAt: DateTime.now().subtract(const Duration(minutes: 1)),
      scopes: const ['openid'],
      claims: const {},
    ));

    expect(await client.getSession(), isNull);
    expect(await SessionStore(storage).loadSession(), isNull);
    expect(httpClient.codeVerifiers, isEmpty);
  });

  test('forceRefresh 清除本地 session 并要求重新授权', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = PkceCallbackClient();
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);
    await SessionStore(storage).saveSession(XidSessionData(
      accessToken: 'access_current',
      refreshToken: 'refresh_old',
      expiresAt: DateTime.now().add(const Duration(hours: 1)),
      scopes: const ['openid'],
      claims: const {},
    ));

    expect(await client.getAccessToken(forceRefresh: true), isNull);
    expect(await SessionStore(storage).loadSession(), isNull);
    expect(httpClient.codeVerifiers, isEmpty);
  });

  test(
      '两次 signIn pending authorization 乱序 callback 使用各自 verifier 且重复 callback 只消费一次',
      () async {
    final sharedStorage = SharedStorageState();
    final firstStorage = NamespacedStorageAdapter(sharedStorage, 'test:pkce');
    final secondStorage = NamespacedStorageAdapter(sharedStorage, 'test:pkce');
    final httpClient = PkceCallbackClient();
    final firstClient = XidClient(httpClient: httpClient);
    final secondClient = XidClient(httpClient: httpClient);
    await configureClient(firstClient, firstStorage);
    await configureClient(secondClient, secondStorage);
    await SessionStore(firstStorage).savePendingAuth(const PendingAuthData(
      state: 'state_first',
      codeVerifier: 'verifier_first',
      codeChallenge: 'challenge_first',
      nonce: 'nonce_first',
    ));
    await SessionStore(secondStorage).savePendingAuth(const PendingAuthData(
      state: 'state_second',
      codeVerifier: 'verifier_second',
      codeChallenge: 'challenge_second',
      nonce: 'nonce_second',
    ));

    await expectLater(
      secondClient.handleRedirect(
        'com.example.app://auth/callback?code=second&state=state_second',
      ),
      throwsA(isA<FormatException>()),
    );
    await expectLater(
      firstClient.handleRedirect(
        'com.example.app://auth/callback?code=first&state=state_first',
      ),
      throwsA(isA<FormatException>()),
    );

    expect(httpClient.codeVerifiers,
        equals(['verifier_second', 'verifier_first']));
    await expectLater(
      firstClient.handleRedirect(
        'com.example.app://auth/callback?code=replay&state=state_first',
      ),
      throwsA(isA<XidAuthException>()),
    );
    expect(httpClient.codeVerifiers,
        equals(['verifier_second', 'verifier_first']));
  });

  test('authorization callback 缺少 id_token 时不会持久化未验证 session', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = PkceCallbackClient(includeIdToken: false);
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);
    await SessionStore(storage).savePendingAuth(const PendingAuthData(
      state: 'state_missing_id',
      codeVerifier: 'verifier_missing_id',
      codeChallenge: 'challenge_missing_id',
      nonce: 'nonce_missing_id',
    ));

    await expectLater(
      client.handleRedirect(
        'com.example.app://auth/callback?code=missing_id&state=state_missing_id',
      ),
      throwsA(
        isA<XidAuthException>().having(
          (error) => error.errorCode,
          'errorCode',
          'id_token_missing',
        ),
      ),
    );
    expect(await SessionStore(storage).loadSession(), isNull);
  });

  test('ID token claims 精确校验 authorization nonce', () {
    const options = IdTokenVerifyOptions(
      issuer: 'https://issuer.example',
      clientId: 'client_1',
      jwksUri: 'https://issuer.example/jwks',
      expectedNonce: 'nonce_expected',
    );
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final claims = <String, dynamic>{
      'iss': 'https://issuer.example',
      'sub': 'user_test',
      'aud': 'client_1',
      'exp': now + 3600,
      'iat': now,
      'nonce': 'nonce_expected',
    };

    expect(
      () => IdTokenVerifier.validateClaims(
        claims,
        const IdTokenVerifyOptions(
          issuer: 'https://issuer.example',
          clientId: 'client_1',
          jwksUri: 'https://issuer.example/jwks',
          expectedNonce: 'nonce_expected',
        ),
      ),
      returnsNormally,
    );
    expect(
      () => IdTokenVerifier.validateClaims(
        claims,
        const IdTokenVerifyOptions(
          issuer: 'https://issuer.example',
          clientId: 'client_1',
          jwksUri: 'https://issuer.example/jwks',
          expectedNonce: 'nonce_other',
        ),
      ),
      throwsA(
        isA<FormatException>().having(
          (error) => error.message,
          'message',
          contains('nonce mismatch'),
        ),
      ),
    );
    expect(
      () => IdTokenVerifier.validateClaims(
        {...claims}..remove('nonce'),
        options,
      ),
      throwsA(
        isA<FormatException>().having(
          (error) => error.message,
          'message',
          contains('nonce mismatch'),
        ),
      ),
    );
    expect(
      () => IdTokenVerifier.validateClaims(
        {...claims}..remove('exp'),
        options,
      ),
      throwsA(
        isA<FormatException>().having(
          (error) => error.message,
          'message',
          contains('valid exp'),
        ),
      ),
    );
  });
}
