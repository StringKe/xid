import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:xid/src/errors.dart';
import 'package:xid/src/token_storage.dart';
import 'package:xid/src/xid_client.dart';
import 'package:xid/src/xid_options.dart';

class GuestFlowClient extends http.BaseClient {
  int guestRequests = 0;
  int meRequests = 0;
  http.Request? lastGuestRequest;
  String? lastMeCookie;
  int guestStatus;
  int meStatus;

  GuestFlowClient({this.guestStatus = 201, this.meStatus = 200});

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
    if (request.url.path == '/auth/guest') {
      guestRequests += 1;
      lastGuestRequest = request as http.Request;
      if (guestStatus != 200 && guestStatus != 201) {
        return _jsonResponse({'error': 'rate_limited'}, status: guestStatus);
      }
      return _jsonResponse(
        {'sessionId': 'sess_guest_1'},
        status: guestStatus,
        headers: {
          // 多个 set-cookie 被拼接成一个 header,且 Expires 日期自带逗号。
          'set-cookie': '__Host-xid.rt.12345678=rt_token; Path=/; HttpOnly; '
              'Secure; SameSite=Strict; Expires=Wed, 21 Oct 2026 07:28:00 GMT, '
              '__Host-xid.anon=anon_key; Path=/; HttpOnly; Secure; '
              'SameSite=Strict; Max-Age=2592000',
        },
      );
    }
    if (request.url.path == '/v1/me') {
      meRequests += 1;
      lastMeCookie = request.headers['cookie'];
      if (meStatus != 200) {
        return _jsonResponse({'error': 'unauthorized'}, status: meStatus);
      }
      return _jsonResponse({
        'user': {
          'id': 'user_guest_1',
          'email': '',
          'emailVerified': false,
          'name': null,
          'imageUrl': null,
          'provisioned_by': 'anonymous',
        },
        'activeOrg': null,
        'organizations': [],
        'session': null,
      });
    }
    throw StateError('unexpected request: ${request.url}');
  }

  http.StreamedResponse _jsonResponse(
    Map<String, dynamic> body, {
    int status = 200,
    Map<String, String>? headers,
  }) {
    return http.StreamedResponse(
      Stream.value(utf8.encode(jsonEncode(body))),
      status,
      headers: {'content-type': 'application/json', ...?headers},
    );
  }
}

class NoRequestClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path == '/.well-known/openid-configuration') {
      return http.StreamedResponse(Stream.value(utf8.encode('{}')), 503);
    }
    throw StateError('unexpected request: ${request.url}');
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
  test('signInAnonymously 建号:请求形状、cookie 捕获回传、持久化、isAnonymous',
      () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = GuestFlowClient();
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);

    final session =
        await client.signInAnonymously(turnstileToken: 'turnstile_x');

    // POST /auth/guest 请求形状:JSON body 携带 turnstileToken。
    expect(httpClient.guestRequests, equals(1));
    final guestRequest = httpClient.lastGuestRequest!;
    expect(guestRequest.method, equals('POST'));
    expect(guestRequest.url.toString(),
        equals('https://issuer.example/auth/guest'));
    expect(guestRequest.headers['content-type'],
        contains('application/json'));
    expect(jsonDecode(guestRequest.body),
        equals({'turnstileToken': 'turnstile_x'}));

    // Set-Cookie 被捕获为 name=value 对,随 /v1/me 的 Cookie 头回传。
    expect(httpClient.meRequests, equals(1));
    final cookie = httpClient.lastMeCookie!;
    expect(cookie, contains('__Host-xid.rt.12345678=rt_token'));
    expect(cookie, contains('__Host-xid.anon=anon_key'));
    expect(cookie, isNot(contains('Expires')));

    // 返回值暴露 guest 判定与连续的 user id。
    expect(session.sessionId, equals('sess_guest_1'));
    expect(session.user.id, equals('user_guest_1'));
    expect(session.isAnonymous, isTrue);

    // 持久化:新 client 实例惰性复用,不再发请求。
    final restarted = XidClient(httpClient: httpClient);
    await configureClient(restarted, storage);
    final reused = await restarted.signInAnonymously();
    expect(reused.sessionId, equals('sess_guest_1'));
    expect(reused.user.id, equals('user_guest_1'));
    expect(httpClient.guestRequests, equals(1));
    expect(httpClient.meRequests, equals(1));
  });

  test('signInAnonymously 不传 turnstileToken 时 body 为空对象', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = GuestFlowClient();
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);

    await client.signInAnonymously();

    expect(jsonDecode(httpClient.lastGuestRequest!.body), equals({}));
  });

  test('signInAnonymously 惰性复用:已有 guest session 不发任何请求', () async {
    final storage = InMemoryStorageAdapter();
    await SessionStore(storage).saveGuestSession(XidGuestSessionData(
      sessionId: 'sess_cached',
      sessionCookies: '__Host-xid.rt.12345678=rt_token',
      user: const {'id': 'user_cached', 'provisioned_by': 'anonymous'},
    ));
    final client = XidClient(httpClient: NoRequestClient());
    await configureClient(client, storage);

    final session = await client.signInAnonymously();

    expect(session.sessionId, equals('sess_cached'));
    expect(session.user.id, equals('user_cached'));
    expect(session.isAnonymous, isTrue);
  });

  test('signInAnonymously /auth/guest 拒绝:抛出且不持久化', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = GuestFlowClient(guestStatus: 429);
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);

    await expectLater(
      client.signInAnonymously(),
      throwsA(isA<XidNetworkException>()
          .having((e) => e.statusCode, 'statusCode', equals(429))),
    );
    expect(httpClient.meRequests, equals(0));
    expect(await SessionStore(storage).loadGuestSession(), isNull);
  });

  test('signInAnonymously /v1/me 失败:抛出且不持久化', () async {
    final storage = InMemoryStorageAdapter();
    final httpClient = GuestFlowClient(meStatus: 401);
    final client = XidClient(httpClient: httpClient);
    await configureClient(client, storage);

    await expectLater(
      client.signInAnonymously(),
      throwsA(isA<XidNetworkException>()
          .having((e) => e.statusCode, 'statusCode', equals(401))),
    );
    expect(await SessionStore(storage).loadGuestSession(), isNull);
  });
}
