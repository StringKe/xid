import 'package:flutter_test/flutter_test.dart';
import 'package:xid/src/token_storage.dart';

class FailingStorageAdapter implements TokenStorageAdapter {
  final Map<String, String> _store = {};
  bool failNextWrite = false;

  @override
  Future<void> clear() async => _store.clear();

  @override
  Future<void> delete(String key) async => _store.remove(key);

  @override
  Future<String?> read(String key) async => _store[key];

  @override
  Future<void> write(String key, String value) async {
    if (failNextWrite) {
      failNextWrite = false;
      throw StateError('storage unavailable');
    }
    _store[key] = value;
  }
}

void main() {
  group('InMemoryStorageAdapter', () {
    late InMemoryStorageAdapter adapter;

    setUp(() => adapter = InMemoryStorageAdapter());

    test('write / read 往返', () async {
      await adapter.write('key1', 'value1');
      expect(await adapter.read('key1'), equals('value1'));
    });

    test('read 不存在的 key 返回 null', () async {
      expect(await adapter.read('not_exist'), isNull);
    });

    test('delete 后 read 返回 null', () async {
      await adapter.write('key2', 'v');
      await adapter.delete('key2');
      expect(await adapter.read('key2'), isNull);
    });

    test('clear 清空所有 key', () async {
      await adapter.write('a', '1');
      await adapter.write('b', '2');
      await adapter.clear();
      expect(await adapter.read('a'), isNull);
      expect(await adapter.read('b'), isNull);
    });
  });

  group('SessionStore', () {
    late SessionStore store;

    setUp(() => store = SessionStore(InMemoryStorageAdapter()));

    test('saveSession / loadSession 往返', () async {
      final data = XidSessionData(
        accessToken: 'at',
        idToken: 'it',
        refreshToken: 'rt',
        expiresAt: DateTime.parse('2099-01-01T00:00:00Z'),
        scopes: ['openid', 'profile'],
        claims: {'sub': 'user_1', 'email': 'test@example.com'},
      );

      await store.saveSession(data);
      final loaded = await store.loadSession();

      expect(loaded, isNotNull);
      expect(loaded!.accessToken, equals('at'));
      expect(loaded.refreshToken, equals('rt'));
      expect(loaded.scopes, equals(['openid', 'profile']));
      expect(loaded.claims['sub'], equals('user_1'));
      expect(loaded.expiresAt, equals(DateTime.parse('2099-01-01T00:00:00Z')));
    });

    test('loadSession 未写入时返回 null', () async {
      expect(await store.loadSession(), isNull);
    });

    test('clearSession 后 loadSession 返回 null', () async {
      final data = XidSessionData(
        accessToken: 'at',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
        scopes: [],
        claims: {'sub': 'u'},
      );
      await store.saveSession(data);
      await store.clearSession();
      expect(await store.loadSession(), isNull);
    });

    test('写入失败后重启仍恢复上一个完整 session', () async {
      final adapter = FailingStorageAdapter();
      final initialStore = SessionStore(adapter);
      final initialSession = XidSessionData(
        accessToken: 'access_old',
        refreshToken: 'refresh_old',
        expiresAt: DateTime.parse('2099-01-01T00:00:00Z'),
        scopes: ['openid'],
        claims: {'sub': 'user_1'},
      );
      await initialStore.saveSession(initialSession);

      adapter.failNextWrite = true;
      await expectLater(
        initialStore.saveSession(XidSessionData(
          accessToken: 'access_new',
          refreshToken: 'refresh_new',
          expiresAt: DateTime.parse('2099-01-02T00:00:00Z'),
          scopes: ['openid'],
          claims: {'sub': 'user_1'},
        )),
        throwsStateError,
      );

      final restartedStore = SessionStore(adapter);
      final restored = await restartedStore.loadSession();
      expect(restored!.accessToken, equals('access_old'));
      expect(restored.refreshToken, equals('refresh_old'));
    });

    test('两次 PKCE authorization 乱序回调使用各自 verifier 且只消费一次', () async {
      await store.savePendingAuth(const PendingAuthData(
        state: 'state_first',
        codeVerifier: 'verifier_first',
        codeChallenge: 'challenge_first',
        nonce: 'nonce_first',
      ));
      await store.savePendingAuth(const PendingAuthData(
        state: 'state_second',
        codeVerifier: 'verifier_second',
        codeChallenge: 'challenge_second',
        nonce: 'nonce_second',
      ));

      final second = await store.consumePendingAuth('state_second');
      final first = await store.consumePendingAuth('state_first');
      final replay = await store.consumePendingAuth('state_first');

      expect(second?.codeVerifier, equals('verifier_second'));
      expect(second?.nonce, equals('nonce_second'));
      expect(first?.codeVerifier, equals('verifier_first'));
      expect(first?.nonce, equals('nonce_first'));
      expect(replay, isNull);
    });
  });
}
