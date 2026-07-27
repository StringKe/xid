/// Set-Cookie 捕获:package:http 不管理 cookie jar,且会把多个同名
/// set-cookie header 用逗号拼接,而 Expires 日期本身含逗号,
/// 只能按「逗号后紧跟 name=」的规则切分。
library;

final _cookieSplit = RegExp(r',(?=[^;,]*=)');

/// 从(可能被拼接的)set-cookie header 提取 "name=value; name=value"
/// 形式的 Cookie 请求头值。无 cookie 时返回 null。
String? cookieHeaderFromSetCookie(String? setCookie) {
  if (setCookie == null || setCookie.isEmpty) return null;
  final pairs = setCookie
      .split(_cookieSplit)
      .map((cookie) {
        final semi = cookie.indexOf(';');
        return (semi == -1 ? cookie : cookie.substring(0, semi)).trim();
      })
      .where((pair) => pair.contains('='))
      .toList();
  if (pairs.isEmpty) return null;
  return pairs.join('; ');
}
