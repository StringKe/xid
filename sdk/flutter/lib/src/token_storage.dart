import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token 存储适配器接口。
///
/// 默认实现 [SecureStorageAdapter] 使用 flutter_secure_storage:
///   iOS/macOS -> Keychain
///   Android   -> Keystore-backed EncryptedSharedPreferences
///   Linux     -> libsecret (Secret Service)
///   Windows   -> DPAPI
///
/// 可通过 [XidClient.setTokenStorage] 替换为自定义实现。
abstract class TokenStorageAdapter {
  Future<void> write(String key, String value);
  Future<String?> read(String key);
  Future<void> delete(String key);
  Future<void> clear();
}

/// 相同物理存储空间的 adapter 实现此接口并返回相同值,
/// 以便多个 [XidClient] 共享 refresh single-flight。
abstract interface class TokenStorageNamespace {
  String get storageNamespace;
}

/// flutter_secure_storage 默认实现。
class SecureStorageAdapter
    implements TokenStorageAdapter, TokenStorageNamespace {
  final FlutterSecureStorage _storage;

  /// [keyPrefix] 防止多 client 实例 key 冲突。
  final String keyPrefix;

  SecureStorageAdapter({
    String? keyPrefix,
    AndroidOptions? androidOptions,
    IOSOptions? iosOptions,
  })  : keyPrefix = keyPrefix ?? 'xid_',
        _storage = FlutterSecureStorage(
          aOptions: androidOptions ??
              const AndroidOptions(
                encryptedSharedPreferences: true,
              ),
          iOptions: iosOptions ??
              const IOSOptions(
                accessibility: KeychainAccessibility.first_unlock,
              ),
        );

  String _k(String key) => '$keyPrefix$key';

  @override
  String get storageNamespace => 'secure:$keyPrefix';

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: _k(key), value: value);

  @override
  Future<String?> read(String key) => _storage.read(key: _k(key));

  @override
  Future<void> delete(String key) => _storage.delete(key: _k(key));

  @override
  Future<void> clear() async {
    // 只清理本 prefix 的 key,避免删除其他 key。
    final all = await _storage.readAll();
    for (final k in all.keys) {
      if (k.startsWith(keyPrefix)) {
        await _storage.delete(key: k);
      }
    }
  }
}

/// 内存存储适配器,仅用于测试。不要在生产环境使用。
class InMemoryStorageAdapter implements TokenStorageAdapter {
  final Map<String, String> _store = {};

  @override
  Future<void> write(String key, String value) async => _store[key] = value;

  @override
  Future<String?> read(String key) async => _store[key];

  @override
  Future<void> delete(String key) async => _store.remove(key);

  @override
  Future<void> clear() async => _store.clear();
}

/// Token 存储 key 常量。
abstract class _StorageKey {
  static const session = 'session';
  static const guestSession = 'guest_session';
  static const pendingAuthorizationPrefix = 'pending_pkce_authorization:';

  static String pendingAuthorization(String state) =>
      '$pendingAuthorizationPrefix$state';
}

/// signIn 与 handleRedirect 之间的 PKCE 飞行状态,持久化到 secure storage 以支持跨进程恢复。
class PendingAuthData {
  final String state;
  final String codeVerifier;
  final String codeChallenge;

  const PendingAuthData({
    required this.state,
    required this.codeVerifier,
    required this.codeChallenge,
  });
}

/// SessionStore: 在 [TokenStorageAdapter] 上封装序列化/反序列化。
class SessionStore {
  final TokenStorageAdapter _adapter;

  SessionStore(this._adapter);

  Future<void> saveSession(XidSessionData data) async {
    await _adapter.write(
        _StorageKey.session,
        jsonEncode({
          'state': 'active',
          'data': data.toJson(),
        }));
  }

  Future<void> markRefreshPending() async {
    await _adapter.write(
        _StorageKey.session, jsonEncode({'state': 'refresh_pending'}));
  }

  Future<XidSessionData?> loadSession() async {
    final encoded = await _adapter.read(_StorageKey.session);
    if (encoded == null) return null;
    final record = jsonDecode(encoded) as Map<String, dynamic>;
    if (record['state'] != 'active') return null;
    return XidSessionData.fromJson(record['data'] as Map<String, dynamic>);
  }

  Future<bool> isRefreshPending() async {
    final encoded = await _adapter.read(_StorageKey.session);
    if (encoded == null) return false;
    final record = jsonDecode(encoded) as Map<String, dynamic>;
    return record['state'] == 'refresh_pending';
  }

  Future<void> clearSession() => _adapter.clear();

  Future<void> saveGuestSession(XidGuestSessionData data) {
    return _adapter.write(_StorageKey.guestSession, jsonEncode(data.toJson()));
  }

  Future<XidGuestSessionData?> loadGuestSession() async {
    final encoded = await _adapter.read(_StorageKey.guestSession);
    if (encoded == null) return null;
    try {
      return XidGuestSessionData.fromJson(
          jsonDecode(encoded) as Map<String, dynamic>);
    } catch (_) {
      // 损坏记录视为不存在,回退到重新建号,而不是把解析错误抛给调用方。
      return null;
    }
  }

  Future<void> clearGuestSession() => _adapter.delete(_StorageKey.guestSession);

  Future<void> savePendingAuth(PendingAuthData data) {
    return _adapter.write(
      _StorageKey.pendingAuthorization(data.state),
      jsonEncode({
        'state': data.state,
        'codeVerifier': data.codeVerifier,
        'codeChallenge': data.codeChallenge,
      }),
    );
  }

  Future<PendingAuthData?> consumePendingAuth(String state) async {
    final key = _StorageKey.pendingAuthorization(state);
    final encoded = await _adapter.read(key);
    if (encoded == null) return null;

    await _adapter.delete(key);
    try {
      final record = jsonDecode(encoded) as Map<String, dynamic>;
      final storedState = record['state'];
      final codeVerifier = record['codeVerifier'];
      final codeChallenge = record['codeChallenge'];
      if (storedState is! String ||
          storedState != state ||
          codeVerifier is! String ||
          codeChallenge is! String) {
        return null;
      }
      return PendingAuthData(
        state: storedState,
        codeVerifier: codeVerifier,
        codeChallenge: codeChallenge,
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> clearPendingAuth(String state) =>
      _adapter.delete(_StorageKey.pendingAuthorization(state));
}

/// 匿名访客会话的持久化数据。sessionCookies 以 "name=value; name=value"
/// 形式保存,后续请求(如 /v1/me)随 Cookie 头原样回传。
class XidGuestSessionData {
  final String sessionId;
  final String sessionCookies;
  final Map<String, dynamic> user;

  XidGuestSessionData({
    required this.sessionId,
    required this.sessionCookies,
    required this.user,
  });

  Map<String, dynamic> toJson() {
    return {
      'sessionId': sessionId,
      'sessionCookies': sessionCookies,
      'user': user,
    };
  }

  factory XidGuestSessionData.fromJson(Map<String, dynamic> json) {
    return XidGuestSessionData(
      sessionId: json['sessionId'] as String,
      sessionCookies: json['sessionCookies'] as String,
      user: Map<String, dynamic>.from(json['user'] as Map),
    );
  }
}

/// 纯数据类,与 xid_client.dart 解耦以避免循环引用。
class XidSessionData {
  final String accessToken;
  final String? idToken;
  final String? refreshToken;
  final DateTime expiresAt;
  final List<String> scopes;
  final Map<String, dynamic> claims;

  XidSessionData({
    required this.accessToken,
    this.idToken,
    this.refreshToken,
    required this.expiresAt,
    required this.scopes,
    required this.claims,
  });

  Map<String, dynamic> toJson() {
    return {
      'accessToken': accessToken,
      'idToken': idToken,
      'refreshToken': refreshToken,
      'expiresAt': expiresAt.toIso8601String(),
      'scopes': scopes,
      'claims': claims,
    };
  }

  factory XidSessionData.fromJson(Map<String, dynamic> json) {
    return XidSessionData(
      accessToken: json['accessToken'] as String,
      idToken: json['idToken'] as String?,
      refreshToken: json['refreshToken'] as String?,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      scopes: List<String>.from(json['scopes'] as List),
      claims: Map<String, dynamic>.from(json['claims'] as Map),
    );
  }
}
