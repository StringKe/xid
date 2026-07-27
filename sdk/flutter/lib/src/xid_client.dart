import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;

import 'discovery.dart';
import 'errors.dart';
import 'cookies.dart';
import 'id_token_verifier.dart';
import 'jwks_cache.dart';
import 'pkce.dart';
import 'session.dart';
import 'token_service.dart';
import 'token_storage.dart';
import 'xid_options.dart';

/// XidClient: XID Flutter SDK 主入口。
///
/// Shared native contract:
///   configure(options) / signIn(options) / handleRedirect(url)
///   getSession() / getAccessToken(options) / signOut() / setTokenStorage(adapter)
///
/// 安全边界:
///   - 使用 PKCE S256,不支持 implicit flow 或 password grant。
///   - 不存储 client_secret(public client)。
///   - Refresh token 使用 flutter_secure_storage 写入平台 secure enclave。
///   - 每次使用 refresh token 即轮换(XID 服务端 rotation + family 策略)。
class XidClient {
  late XidOptions _options;
  OidcDiscovery? _discovery;
  late SessionStore _sessionStore;
  late TokenStorageAdapter _tokenStorage;
  late TokenService _tokenService;
  final http.Client _httpClient;
  bool _configured = false;

  JwksCache? _jwksCache;
  IdTokenVerifier? _idTokenVerifierInstance;

  static final Map<String, _RefreshCoordinator> _refreshCoordinators = {};
  static final Map<String, Future<void>> _pendingAuthorizationTails = {};

  XidClient({http.Client? httpClient})
      : _httpClient = httpClient ?? http.Client();

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------

  /// 初始化 SDK。必须在调用其他 API 前调用。
  ///
  /// [options] 包含 issuer、clientId、redirectUri 等配置。
  /// [storageAdapter] 默认使用 [SecureStorageAdapter]。
  Future<void> configure(
    XidOptions options, {
    TokenStorageAdapter? storageAdapter,
  }) async {
    _options = options;
    _tokenStorage = storageAdapter ?? SecureStorageAdapter();
    _sessionStore = SessionStore(_tokenStorage);
    _tokenService = TokenService(httpClient: _httpClient);
    _configured = true;

    // 预 fetch discovery(非阻塞,失败不抛出,调用时懒加载)
    try {
      _discovery = await OidcDiscovery.fetch(
        options.effectiveDiscoveryUrl,
        client: _httpClient,
      );
    } catch (_) {
      _discovery = null;
    }
  }

  // ---------------------------------------------------------------------------
  // setTokenStorage
  // ---------------------------------------------------------------------------

  /// 替换 token 存储适配器(必须在 [configure] 之后调用)。
  void setTokenStorage(TokenStorageAdapter adapter) {
    _tokenStorage = adapter;
    _sessionStore = SessionStore(adapter);
  }

  // ---------------------------------------------------------------------------
  // signIn
  // ---------------------------------------------------------------------------

  /// 打开 Hosted Auth 系统浏览器,完成授权后返回 [XidSession]。
  ///
  /// 内部流程:
  ///   1. 确保 discovery 已加载。
  ///   2. 生成 PKCE code_verifier / code_challenge(S256)。
  ///   3. 构造 /authorize URL 并使用 flutter_web_auth_2 打开系统浏览器。
  ///   4. 接收回调 URL(App Link 或 custom scheme)。
  ///   5. 从 URL 提取 code,调用 /token 完成 code exchange。
  ///   6. 持久化 session,返回 [XidSession]。
  ///
  /// [additionalParameters] 可覆盖或追加 authorize 参数(prompt / login_hint 等)。
  Future<XidSession> signIn({
    Map<String, String> additionalParameters = const {},
    String? audience,
    bool forceRefresh = false,
  }) async {
    _assertConfigured();
    final discovery = await _ensureDiscovery();

    // 生成 PKCE pair
    final pkce = Pkce.generate();
    final state = _generateState();

    await _sessionStore.savePendingAuth(PendingAuthData(
      state: state,
      codeVerifier: pkce.codeVerifier,
      codeChallenge: pkce.codeChallenge,
    ));

    final params = <String, String>{
      'response_type': 'code',
      'client_id': _options.clientId,
      'redirect_uri': _options.redirectUri,
      'scope': _options.scopes.join(' '),
      'state': state,
      'code_challenge': pkce.codeChallenge,
      'code_challenge_method': pkce.codeChallengeMethod,
      ..._options.additionalParameters,
      ...additionalParameters,
    };

    if (audience != null) params['audience'] = audience;

    final authorizeUri = Uri.parse(discovery.authorizationEndpoint)
        .replace(queryParameters: params);

    // 使用 flutter_web_auth_2 打开系统浏览器并等待回调。
    // callbackUrlScheme 必须与 redirectUri scheme 一致。
    final callbackScheme = _extractScheme(_options.redirectUri);

    final String resultUrl;
    try {
      resultUrl = await FlutterWebAuth2.authenticate(
        url: authorizeUri.toString(),
        callbackUrlScheme: callbackScheme,
      );
    } on PlatformException catch (e) {
      await _sessionStore.clearPendingAuth(state);
      if (e.code == 'CANCELED') {
        throw const UserCancelledException();
      }
      throw XidAuthException(
        '授权失败',
        errorCode: 'authorization_failed',
        cause: e,
      );
    } catch (e) {
      await _sessionStore.clearPendingAuth(state);
      throw XidAuthException(
        '用户取消授权或浏览器关闭',
        errorCode: 'access_denied',
        cause: e,
      );
    }

    return handleRedirect(resultUrl);
  }

  // ---------------------------------------------------------------------------
  // signInAnonymously
  // ---------------------------------------------------------------------------

  /// Firebase 式匿名登录:POST /auth/guest 建立访客会话,返回 [XidGuestSession]。
  ///
  /// 惰性语义:本地已有持久化的 guest session 时直接返回,不发任何请求。
  /// guest 没有 access token;会话凭证是 /auth/guest 通过 Set-Cookie 签发的
  /// HttpOnly cookie,原生端自行捕获并持久化,后续请求(如 /v1/me)随 Cookie 头回传。
  ///
  /// [turnstileToken] 仅在服务端启用 Turnstile 时需要,native 端通常不需要。
  Future<XidGuestSession> signInAnonymously({String? turnstileToken}) async {
    _assertConfigured();

    final stored = await _sessionStore.loadGuestSession();
    if (stored != null) {
      return XidGuestSession(
        sessionId: stored.sessionId,
        user: XidUser.fromMeJson(stored.user),
      );
    }

    final issuer = _options.issuer;
    final guestResponse = await _httpClient.post(
      Uri.parse('$issuer/auth/guest'),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: jsonEncode({
        if (turnstileToken != null) 'turnstileToken': turnstileToken,
      }),
    );
    if (guestResponse.statusCode != 200 && guestResponse.statusCode != 201) {
      throw XidNetworkException(
        '匿名登录失败: HTTP ${guestResponse.statusCode}',
        statusCode: guestResponse.statusCode,
      );
    }

    final sessionId =
        (jsonDecode(guestResponse.body) as Map<String, dynamic>)['sessionId'];
    if (sessionId is! String) {
      throw const XidNetworkException('匿名登录响应缺少 sessionId');
    }

    // 会话凭证在 Set-Cookie 里;package:http 不管理 cookie jar,需手动捕获并回传。
    final cookies =
        cookieHeaderFromSetCookie(guestResponse.headers['set-cookie']);
    final meResponse = await _httpClient.get(
      Uri.parse('$issuer/v1/me'),
      headers: {
        'Accept': 'application/json',
        if (cookies != null) 'Cookie': cookies,
      },
    );
    if (meResponse.statusCode != 200) {
      throw XidNetworkException(
        '获取访客用户失败: HTTP ${meResponse.statusCode}',
        statusCode: meResponse.statusCode,
      );
    }

    final userJson =
        (jsonDecode(meResponse.body) as Map<String, dynamic>)['user'];
    if (userJson is! Map<String, dynamic>) {
      throw const XidNetworkException('/v1/me 响应缺少 user');
    }

    await _sessionStore.saveGuestSession(XidGuestSessionData(
      sessionId: sessionId,
      sessionCookies: cookies ?? '',
      user: userJson,
    ));

    return XidGuestSession(
      sessionId: sessionId,
      user: XidUser.fromMeJson(userJson),
    );
  }

  // ---------------------------------------------------------------------------
  // handleRedirect
  // ---------------------------------------------------------------------------

  /// 处理 App Link / custom scheme 回调 URL,完成 code exchange。
  ///
  /// 通常由 [signIn] 内部调用;也可在 deep link handler 中手动调用(跨进程恢复)。
  Future<XidSession> handleRedirect(String url) async {
    _assertConfigured();
    final discovery = await _ensureDiscovery();

    final uri = Uri.parse(url);
    final returnedState = uri.queryParameters['state'];
    if (returnedState == null) {
      throw const XidAuthException(
        '回调 URL 缺少 state 参数',
        errorCode: 'missing_state',
      );
    }

    final pending = await _consumePendingAuth(returnedState);
    if (pending == null) {
      throw const XidAuthException(
        '无法恢复 PKCE state,请重新发起 signIn',
        errorCode: 'pkce_state_lost',
      );
    }

    // 检查 error 参数
    final error = uri.queryParameters['error'];
    if (error != null) {
      throw XidAuthException(
        'Authorization 错误',
        errorCode: error,
        errorDescription: uri.queryParameters['error_description'],
      );
    }

    final code = uri.queryParameters['code'];
    if (code == null) {
      throw const XidAuthException(
        '回调 URL 缺少 code 参数',
        errorCode: 'missing_code',
      );
    }

    // Code Exchange
    final tokenResponse = await _tokenService.exchangeCode(
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: _options.clientId,
      code: code,
      redirectUri: _options.redirectUri,
      codeVerifier: pending.codeVerifier,
    );

    final session = await XidSession.fromTokenResponse(
      tokenResponse,
      verifyOptions: IdTokenVerifyOptions(
        issuer: _options.issuer,
        clientId: _options.clientId,
        jwksUri: discovery.jwksUri,
      ),
      verifier: _idTokenVerifier(discovery),
    );
    await _persistSession(session);
    return session;
  }

  Future<PendingAuthData?> _consumePendingAuth(String state) async {
    final namespace = _tokenStorage is TokenStorageNamespace
        ? (_tokenStorage as TokenStorageNamespace).storageNamespace
        : 'adapter:${identityHashCode(_tokenStorage)}';
    final previous = _pendingAuthorizationTails[namespace] ?? Future.value();
    final completion = Completer<void>();
    final tail = previous.then((_) => completion.future);
    _pendingAuthorizationTails[namespace] = tail;

    await previous;
    try {
      return await _sessionStore.consumePendingAuth(state);
    } finally {
      completion.complete();
      if (identical(_pendingAuthorizationTails[namespace], tail)) {
        _pendingAuthorizationTails.remove(namespace);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // getSession
  // ---------------------------------------------------------------------------

  /// 返回当前有效 session,如果 access_token 即将过期则自动 refresh。
  ///
  /// 返回 null 表示未登录。
  Future<XidSession?> getSession() async {
    _assertConfigured();
    final data = await _sessionStore.loadSession();
    if (data == null) return _awaitSharedRefresh();

    var session = _sessionDataToSession(data);

    if (session.needsRefresh()) {
      final refreshToken = data.refreshToken;
      if (refreshToken == null) return null; // 无法刷新
      session = await _refresh(refreshToken);
    }

    return session;
  }

  // ---------------------------------------------------------------------------
  // getAccessToken
  // ---------------------------------------------------------------------------

  /// 返回有效 access_token 字符串。
  ///
  /// [forceRefresh] = true 时强制刷新。
  Future<String?> getAccessToken({bool forceRefresh = false}) async {
    _assertConfigured();
    final data = await _sessionStore.loadSession();
    if (data == null) return (await _awaitSharedRefresh())?.accessToken;

    if (!forceRefresh && !_sessionDataToSession(data).needsRefresh()) {
      return data.accessToken;
    }

    final refreshToken = data.refreshToken;
    if (refreshToken == null) return null;

    final session = await _refresh(refreshToken);
    return session.accessToken;
  }

  // ---------------------------------------------------------------------------
  // signOut
  // ---------------------------------------------------------------------------

  /// 注销:吊销 refresh_token(RFC 7009)并清除本地存储。
  ///
  /// [openLogoutUrl] = true 时(默认)还会打开 end_session_endpoint
  /// 清除服务端 SSO session。
  Future<void> signOut({bool openLogoutUrl = true}) async {
    _assertConfigured();
    final data = await _sessionStore.loadSession();
    final discovery = await _ensureDiscovery();

    // 先吊销 refresh_token(best effort,失败不阻塞注销)
    if (data?.refreshToken != null && discovery.revocationEndpoint != null) {
      await _tokenService
          .revokeToken(
            revocationEndpoint: discovery.revocationEndpoint!,
            clientId: _options.clientId,
            token: data!.refreshToken!,
            tokenTypeHint: 'refresh_token',
          )
          .onError((_, __) => null); // best effort
    }

    // 清除本地存储
    await _sessionStore.clearSession();

    // 打开 end_session_endpoint 清除服务端 SSO session
    if (openLogoutUrl && discovery.endSessionEndpoint != null) {
      final params = <String, String>{};
      if (data?.idToken != null) params['id_token_hint'] = data!.idToken!;
      if (_options.postLogoutRedirectUri != null) {
        params['post_logout_redirect_uri'] = _options.postLogoutRedirectUri!;
      }

      final endSessionUri = Uri.parse(discovery.endSessionEndpoint!)
          .replace(queryParameters: params.isEmpty ? null : params);

      final callbackScheme = _options.postLogoutRedirectUri != null
          ? _extractScheme(_options.postLogoutRedirectUri!)
          : _extractScheme(_options.redirectUri);

      try {
        await FlutterWebAuth2.authenticate(
          url: endSessionUri.toString(),
          callbackUrlScheme: callbackScheme,
        );
      } on PlatformException catch (e) {
        // 用户关闭浏览器(CANCELED)不阻断注销流程
        if (e.code != 'CANCELED') {
          // 其他平台错误同样 best-effort 忽略
        }
      } catch (_) {
        // best effort
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  void _assertConfigured() {
    if (!_configured) {
      throw const XidConfigException('XidClient 未初始化,请先调用 configure()');
    }
  }

  Future<OidcDiscovery> _ensureDiscovery() async {
    _discovery ??= await OidcDiscovery.fetch(
      _options.effectiveDiscoveryUrl,
      client: _httpClient,
    );
    return _discovery!;
  }

  Future<XidSession?> _awaitSharedRefresh() async {
    if (!await _sessionStore.isRefreshPending()) return null;
    return _refreshCoordinators[_storageNamespace()]?.inFlight;
  }

  Future<XidSession> _refresh(String refreshToken) {
    final storageNamespace = _storageNamespace();
    final coordinator =
        _refreshCoordinators[storageNamespace] ?? _RefreshCoordinator();
    _refreshCoordinators[storageNamespace] = coordinator;
    final existing = coordinator.inFlight;
    if (existing != null) return existing;

    late final Future<XidSession> operation;
    operation = _refreshOnce(refreshToken).whenComplete(() {
      if (identical(coordinator.inFlight, operation)) {
        coordinator.inFlight = null;
        if (identical(_refreshCoordinators[storageNamespace], coordinator)) {
          _refreshCoordinators.remove(storageNamespace);
        }
      }
    });
    coordinator.inFlight = operation;
    return operation;
  }

  Future<XidSession> _refreshOnce(String refreshToken) async {
    final discovery = await _ensureDiscovery();
    await _sessionStore.markRefreshPending();
    try {
      final tokenResponse = await _tokenService.refreshTokens(
        tokenEndpoint: discovery.tokenEndpoint,
        clientId: _options.clientId,
        refreshToken: refreshToken,
      );

      final session = await XidSession.fromTokenResponse(
        tokenResponse,
        verifyOptions: IdTokenVerifyOptions(
          issuer: _options.issuer,
          clientId: _options.clientId,
          jwksUri: discovery.jwksUri,
        ),
        verifier: _idTokenVerifier(discovery),
      );
      await _persistSession(session);
      return session;
    } catch (_) {
      await _sessionStore.clearSession();
      rethrow;
    }
  }

  String _storageNamespace() {
    final storage = _tokenStorage;
    if (storage is TokenStorageNamespace) {
      return (storage as TokenStorageNamespace).storageNamespace;
    }
    return 'adapter:${identityHashCode(storage)}';
  }

  IdTokenVerifier _idTokenVerifier(OidcDiscovery discovery) {
    _jwksCache ??= JwksCache(
      jwksUri: discovery.jwksUri,
      httpClient: _httpClient,
    );
    _idTokenVerifierInstance ??= IdTokenVerifier(cache: _jwksCache!);
    return _idTokenVerifierInstance!;
  }

  Future<void> _persistSession(XidSession session) async {
    await _sessionStore.saveSession(XidSessionData(
      accessToken: session.accessToken,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      scopes: session.scopes,
      claims: session.claims,
    ));
    // 正式登录后匿名记录失效:转正 sub 不变、换账号 sub 变,
    // 两种情况下旧 guest 的惰性快捷路径都不能再用。
    await _sessionStore.clearGuestSession();
  }

  XidSession _sessionDataToSession(XidSessionData data) {
    return XidSession(
      accessToken: data.accessToken,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
      scopes: data.scopes,
      claims: data.claims,
    );
  }

  static String _generateState({int length = 32}) {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    final rng = Random.secure();
    return List.generate(length, (_) => chars[rng.nextInt(chars.length)])
        .join();
  }

  /// 从 URI 提取 scheme(flutter_web_auth_2 需要)。
  /// https://example.com/... -> https
  /// com.example.app://...  -> com.example.app
  static String _extractScheme(String uri) {
    final parsed = Uri.parse(uri);
    return parsed.scheme;
  }
}

class _RefreshCoordinator {
  Future<XidSession>? inFlight;
}
