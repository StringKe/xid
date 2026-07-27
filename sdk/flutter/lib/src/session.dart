import 'dart:convert';

import 'id_token_verifier.dart';
import 'jwks_cache.dart';

/// XID 会话模型。
///
/// [XidSession] 持有 token 集与已解析的用户/组织信息。
/// 字段来自 ID token claims 和 /userinfo 响应,遵循 OIDC Core。

/// 用户信息,来自 ID token sub + standard claims。
class XidUser {
  final String id; // sub
  final String? email;
  final bool emailVerified;
  final String? name;
  final String? givenName;
  final String? familyName;
  final String? picture;
  final String? phoneNumber;
  final bool phoneNumberVerified;

  /// 开通来源(XID 扩展)。'anonymous' 表示匿名访客(guest)账号。
  final String? provisionedBy;

  const XidUser({
    required this.id,
    this.email,
    this.emailVerified = false,
    this.name,
    this.givenName,
    this.familyName,
    this.picture,
    this.phoneNumber,
    this.phoneNumberVerified = false,
    this.provisionedBy,
  });

  /// 是否匿名访客:仅认 provisioned_by == 'anonymous'(与 /v1/me 契约一致)。
  bool get isAnonymous => provisionedBy == 'anonymous';

  factory XidUser.fromClaims(Map<String, dynamic> claims) {
    return XidUser(
      id: claims['sub'] as String,
      email: claims['email'] as String?,
      emailVerified: claims['email_verified'] as bool? ?? false,
      name: claims['name'] as String?,
      givenName: claims['given_name'] as String?,
      familyName: claims['family_name'] as String?,
      picture: claims['picture'] as String?,
      phoneNumber: claims['phone_number'] as String?,
      phoneNumberVerified: claims['phone_number_verified'] as bool? ?? false,
      provisionedBy: claims['provisioned_by'] as String?,
    );
  }

  /// 从 GET /v1/me 的 user 对象构造(camelCase 字段 + provisioned_by 契约字段)。
  factory XidUser.fromMeJson(Map<String, dynamic> json) {
    return XidUser(
      id: json['id'] as String,
      email: json['email'] as String?,
      emailVerified: json['emailVerified'] as bool? ?? false,
      name: json['name'] as String?,
      picture: json['imageUrl'] as String?,
      provisionedBy: json['provisioned_by'] as String?,
    );
  }
}

/// 组织信息,来自 ID token org_id / org_slug claims(XID 扩展)。
class XidOrganization {
  final String id;
  final String? slug;
  final String? name;

  const XidOrganization({required this.id, this.slug, this.name});

  factory XidOrganization.fromClaims(Map<String, dynamic> claims) {
    return XidOrganization(
      id: claims['org_id'] as String,
      slug: claims['org_slug'] as String?,
      name: claims['org_name'] as String?,
    );
  }
}

/// 完整会话状态:token + 解析后的用户/组织。
class XidSession {
  final String accessToken;
  final String? idToken;
  final String? refreshToken;

  /// access_token 过期时间(UTC)。
  final DateTime expiresAt;

  final List<String> scopes;

  /// 已解析的 ID token claims(传入 verifyOptions 时经 JWKS 验签)。
  final Map<String, dynamic> claims;

  XidSession({
    required this.accessToken,
    this.idToken,
    this.refreshToken,
    required this.expiresAt,
    required this.scopes,
    required this.claims,
  });

  bool get isExpired => DateTime.now().isAfter(expiresAt);

  /// 距过期还有余量(默认提前 60s 视为需要刷新)。
  bool needsRefresh({Duration buffer = const Duration(seconds: 60)}) =>
      DateTime.now().isAfter(expiresAt.subtract(buffer));

  XidUser get user => XidUser.fromClaims(claims);

  XidOrganization? get organization {
    final orgId = claims['org_id'] as String?;
    if (orgId == null) return null;
    return XidOrganization.fromClaims(claims);
  }

  /// 从 /token 端点响应构造。
  ///
  /// 传入 [verifyOptions] 与 [jwksCache] 时对 id_token 做 JWKS 验签;
  /// 未传入时仅解析 payload(与旧行为兼容)。
  static Future<XidSession> fromTokenResponse(
    Map<String, dynamic> tokenResponse, {
    IdTokenVerifyOptions? verifyOptions,
    IdTokenVerifier? verifier,
  }) async {
    final accessToken = tokenResponse['access_token'] as String;
    final idToken = tokenResponse['id_token'] as String?;
    final refreshToken = tokenResponse['refresh_token'] as String?;
    final expiresIn = tokenResponse['expires_in'] as int? ?? 3600;
    final scope = tokenResponse['scope'] as String? ?? '';

    final expiresAt = DateTime.now().add(Duration(seconds: expiresIn));
    final scopes = scope.isEmpty ? <String>[] : scope.split(' ');

    Map<String, dynamic> claims = {};
    if (idToken != null) {
      if (verifyOptions != null) {
        final v = verifier ??
            IdTokenVerifier(
              cache: JwksCache(jwksUri: verifyOptions.jwksUri),
            );
        claims = await v.verify(idToken, verifyOptions);
      } else {
        claims = _decodeJwtPayload(idToken);
      }
    }

    return XidSession(
      accessToken: accessToken,
      idToken: idToken,
      refreshToken: refreshToken,
      expiresAt: expiresAt,
      scopes: scopes,
      claims: claims,
    );
  }
}

/// 匿名访客会话:guest 没有 OAuth token,凭证是服务端签发的 HttpOnly session cookie。
///
/// guest 是真用户实体(provisioned_by = 'anonymous'),可原地转正:
/// 转正(完成任一正式登录)后 user.id(sub)不变,RP 数据自然延续;
/// 若转而登入另一个既有账号,user.id 会变,调用方可对比新旧 user.id 区分。
class XidGuestSession {
  /// 服务端 session id,与持久化的 session cookie 对应。
  final String sessionId;

  final XidUser user;

  const XidGuestSession({required this.sessionId, required this.user});

  bool get isAnonymous => user.isAnonymous;
}

/// 解析 JWT payload(不验签,仅用于无 JWKS 时的降级路径)。
Map<String, dynamic> _decodeJwtPayload(String jwt) {
  final parts = jwt.split('.');
  if (parts.length != 3) return {};
  try {
    // Base64url -> Base64 standard -> bytes -> JSON
    var payload = parts[1];
    // padding
    final pad = 4 - payload.length % 4;
    if (pad != 4) payload += '=' * pad;
    // url-safe chars -> standard base64
    payload = payload.replaceAll('-', '+').replaceAll('_', '/');

    final bytes = base64Decode(payload);
    final json = utf8.decode(bytes);
    return jsonDecode(json) as Map<String, dynamic>;
  } catch (_) {
    return {};
  }
}
