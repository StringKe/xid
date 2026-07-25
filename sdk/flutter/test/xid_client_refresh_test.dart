import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:xid/src/errors.dart';
import 'package:xid/src/token_storage.dart';
import 'package:xid/src/xid_client.dart';
import 'package:xid/src/xid_options.dart';

class RefreshCountingClient extends http.BaseClient {
  final refreshStarted = Completer<void>();
  final releaseRefresh = Completer<void>();
  int refreshRequests = 0;

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
      refreshRequests += 1;
      refreshStarted.complete();
      await releaseRefresh.future;
      return _jsonResponse({
        'access_token': 'access_new',
        'refresh_token': 'refresh_new',
        'expires_in': 3600,
        'scope': 'openid',
      });
    }
    throw StateError('unexpected request: ${request.url}');
  }

  http.StreamedResponse _jsonResponse(Map<String, dynamic> body) {
    return http.StreamedResponse(
      Stream.value(utf8.encode(jsonEncode(body))),
      200,
      headers: {'content-type': 'application/json'},
    );
  }
}

class FailingActiveSessionStorage implements TokenStorageAdapter {
  final Map<String, String> _store = {};
  bool failActiveWrite = false;

  @override
  Future<void> clear() async => _store.clear();

  @override
  Future<void> delete(String key) async => _store.remove(key);

  @override
  Future<String?> read(String key) async => _store[key];

  @override
  Future<void> write(String key, String value) async {
    if (failActiveWrite && value.contains('"state":"active"')) {
      throw StateError('active session commit failed');
    }
    _store[key] = value;
  }
}

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

class DiscoveryRetryClient extends RefreshCountingClient {
  bool discoveryAvailable = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path == '/.well-known/openid-configuration' &&
        !discoveryAvailable) {
      return http.StreamedResponse(Stream.value(utf8.encode('{}')), 503);
    }
    return super.send(request);
  }
}

class PkceCallbackClient extends http.BaseClient {
  final List<String> codeVerifiers = [];

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
      return _jsonResponse({
        'access_token': 'access_${body['code']}',
        'expires_in': 3600,
      });
    }
    throw StateError('unexpected request: ${request.url}');
  }

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
  test('并发 refresh 复用一次 token rotation 并持久化新 session', () async {
    final sharedStorage = SharedStorageState();
    final firstStorage = NamespacedStorageAdapter(sharedStorage, 'test:shared');
    final secondStorage =
        NamespacedStorageAdapter(sharedStorage, 'test:shared');
    final httpClient = RefreshCountingClient();
    final firstClient = XidClient(httpClient: httpClient);
    final secondClient = XidClient(httpClient: httpClient);
    await configureClient(firstClient, firstStorage);
    await configureClient(secondClient, secondStorage);
    await SessionStore(firstStorage).saveSession(XidSessionData(
      accessToken: 'access_old',
      refreshToken: 'refresh_old',
      expiresAt: DateTime.now().subtract(const Duration(minutes: 1)),
      scopes: const ['openid'],
      claims: const {},
    ));

    final sessionFuture = firstClient.getSession();
    final tokenFuture = secondClient.getAccessToken(forceRefresh: true);
    await httpClient.refreshStarted.future;
    expect(httpClient.refreshRequests, equals(1));

    httpClient.releaseRefresh.complete();
    final session = await sessionFuture;
    final token = await tokenFuture;

    expect(session!.accessToken, equals('access_new'));
    expect(token, equals('access_new'));
    expect(httpClient.refreshRequests, equals(1));

    final restartedSession = await SessionStore(firstStorage).loadSession();
    expect(restartedSession!.accessToken, equals('access_new'));
    expect(restartedSession.refreshToken, equals('refresh_new'));
  });

  test('rotation 成功后 active session 提交失败，重启不重放旧 refresh token', () async {
    final storage = FailingActiveSessionStorage();
    final httpClient = RefreshCountingClient();
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);
    await SessionStore(storage).saveSession(XidSessionData(
      accessToken: 'access_old',
      refreshToken: 'refresh_old',
      expiresAt: DateTime.now().subtract(const Duration(minutes: 1)),
      scopes: const ['openid'],
      claims: const {},
    ));
    storage.failActiveWrite = true;

    final refresh = client.getAccessToken(forceRefresh: true);
    await httpClient.refreshStarted.future;
    httpClient.releaseRefresh.complete();

    await expectLater(refresh, throwsStateError);
    expect(httpClient.refreshRequests, equals(1));

    final restartedClient = XidClient(httpClient: httpClient);
    await configureClient(restartedClient, storage);
    expect(await restartedClient.getAccessToken(forceRefresh: true), isNull);
    expect(httpClient.refreshRequests, equals(1));
  });

  test('discovery 失败不会遗留 refresh_pending，恢复后可安全重试', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = DiscoveryRetryClient();
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);
    await SessionStore(storage).saveSession(XidSessionData(
      accessToken: 'access_old',
      refreshToken: 'refresh_old',
      expiresAt: DateTime.now().subtract(const Duration(minutes: 1)),
      scopes: const ['openid'],
      claims: const {},
    ));

    await expectLater(
      client.getAccessToken(forceRefresh: true),
      throwsA(isA<XidNetworkException>()),
    );
    expect(await SessionStore(storage).isRefreshPending(), isFalse);
    expect((await SessionStore(storage).loadSession())?.refreshToken,
        equals('refresh_old'));

    httpClient.discoveryAvailable = true;
    final refresh = client.getAccessToken(forceRefresh: true);
    await httpClient.refreshStarted.future;
    httpClient.releaseRefresh.complete();
    expect(await refresh, equals('access_new'));
    expect(httpClient.refreshRequests, equals(1));
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
    ));
    await SessionStore(secondStorage).savePendingAuth(const PendingAuthData(
      state: 'state_second',
      codeVerifier: 'verifier_second',
      codeChallenge: 'challenge_second',
    ));

    await secondClient.handleRedirect(
      'com.example.app://auth/callback?code=second&state=state_second',
    );
    await firstClient.handleRedirect(
      'com.example.app://auth/callback?code=first&state=state_first',
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
}
