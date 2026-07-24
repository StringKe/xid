/// SDK 错误体系。所有公开异常从 [XidException] 派生。
sealed class XidException implements Exception {
  final String message;
  final Object? cause;

  const XidException(this.message, {this.cause});

  @override
  String toString() => 'XidException: $message${cause != null ? ' (cause: $cause)' : ''}';
}

/// 配置缺失或格式不合法。
final class XidConfigException extends XidException {
  const XidConfigException(super.message, {super.cause});

  @override
  String toString() => 'XidConfigException: $message';
}

/// 用户主动取消授权或关闭系统浏览器。
final class UserCancelledException extends XidAuthException {
  const UserCancelledException([String message = '用户取消授权'])
      : super(message, errorCode: 'access_denied');
}

/// 认证流程错误:用户取消、code 交换失败、token 无效等。
class XidAuthException extends XidException {
  /// OAuth2 error code, 例如 access_denied / invalid_grant。
  final String? errorCode;

  /// OAuth2 error_description。
  final String? errorDescription;

  const XidAuthException(
    super.message, {
    this.errorCode,
    this.errorDescription,
    super.cause,
  });

  @override
  String toString() =>
      'XidAuthException[$errorCode]: $message'
      '${errorDescription != null ? ' - $errorDescription' : ''}';
}

/// 网络或 HTTP 错误。
final class XidNetworkException extends XidException {
  final int? statusCode;

  const XidNetworkException(super.message, {this.statusCode, super.cause});

  @override
  String toString() =>
      'XidNetworkException${statusCode != null ? '[$statusCode]' : ''}: $message';
}
