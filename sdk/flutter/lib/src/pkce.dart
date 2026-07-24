import 'dart:convert';
import 'dart:math';
import 'package:crypto/crypto.dart';

/// PKCE S256 工具类。
///
/// 规范: RFC 7636。
/// code_verifier: 43-128 个 URL-safe 随机字符 [A-Za-z0-9-._~]。
/// code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))。
class Pkce {
  static const _chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

  final String codeVerifier;
  final String codeChallenge;

  // 始终 S256,不支持 plain(XID 服务端拒绝 plain)。
  final String codeChallengeMethod = 'S256';

  Pkce._({required this.codeVerifier, required this.codeChallenge});

  /// 从 secure storage 恢复已生成的 PKCE 对(跨进程 handleRedirect)。
  factory Pkce.fromStored({
    required String codeVerifier,
    required String codeChallenge,
  }) =>
      Pkce._(codeVerifier: codeVerifier, codeChallenge: codeChallenge);

  /// 生成一对 verifier/challenge。
  factory Pkce.generate({int length = 128}) {
    assert(length >= 43 && length <= 128, 'code_verifier 长度必须 43-128');

    final rng = Random.secure();
    final verifier = List.generate(
      length,
      (_) => _chars[rng.nextInt(_chars.length)],
    ).join();

    final challenge = _computeChallenge(verifier);
    return Pkce._(codeVerifier: verifier, codeChallenge: challenge);
  }

  static String _computeChallenge(String verifier) {
    final bytes = utf8.encode(verifier);
    final digest = sha256.convert(bytes);
    // BASE64URL: 无 padding,替换 + -> -, / -> _
    return base64Url.encode(digest.bytes).replaceAll('=', '');
  }
}
