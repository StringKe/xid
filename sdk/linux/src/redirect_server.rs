use crate::error::{Result, XidError};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// loopback redirect_uri 接收服务器返回的 callback 参数
#[derive(Debug)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// 启动一次性 TCP 服务器监听指定端口,等待浏览器 redirect,
/// 解析 query string 返回 code + state。
///
/// 服务器在接收到第一个请求后立即关闭,向浏览器返回简单的 HTML 提示页。
pub async fn wait_for_callback(port: u16) -> Result<CallbackParams> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| XidError::RedirectServerError(format!("监听 {addr} 失败: {e}")))?;

    // 等待单个连接
    let (mut stream, _peer) = listener
        .accept()
        .await
        .map_err(|e| XidError::RedirectServerError(format!("accept 失败: {e}")))?;

    // 读取 HTTP 请求头 (最多 8KB)
    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| XidError::RedirectServerError(format!("读取请求失败: {e}")))?;

    let request = String::from_utf8_lossy(&buf[..n]);

    // 解析请求行: "GET /callback?code=...&state=... HTTP/1.1"
    let first_line = request.lines().next().unwrap_or("");
    let path_part = first_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("");

    let query = path_part.splitn(2, '?').nth(1).unwrap_or("");
    let params = parse_query(query);

    // 无论参数是否完整,都先向浏览器返回提示页
    let (body, status) = if params.contains_key("error") {
        let desc = params.get("error_description").map(|s| s.as_str()).unwrap_or("未知错误");
        (
            format!("<html><body><h2>登录失败</h2><p>{desc}</p><p>你可以关闭此标签页。</p></body></html>"),
            "400 Bad Request",
        )
    } else {
        (
            "<html><body><h2>登录成功</h2><p>你可以关闭此标签页,返回应用。</p></body></html>".into(),
            "200 OK",
        )
    };

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
    drop(stream);
    drop(listener);

    // 检查 error 参数
    if let Some(err) = params.get("error") {
        let desc = params
            .get("error_description")
            .map(|s| s.as_str())
            .unwrap_or("authorization server 返回错误");
        return Err(XidError::RedirectServerError(format!("{err}: {desc}")));
    }

    let code = params
        .get("code")
        .cloned()
        .ok_or(XidError::AuthCallbackError)?;
    let state = params
        .get("state")
        .cloned()
        .ok_or(XidError::AuthCallbackError)?;

    Ok(CallbackParams { code, state })
}

/// 解析 URL query string 为 key-value map
fn parse_query(query: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_query_extracts_code_and_state() {
        let q = "code=abc123&state=xyz_state";
        let params = parse_query(q);
        assert_eq!(params.get("code").map(String::as_str), Some("abc123"));
        assert_eq!(params.get("state").map(String::as_str), Some("xyz_state"));
    }

    #[test]
    fn parse_query_handles_percent_encoded_values() {
        let q = "code=abc%20def&state=s1";
        let params = parse_query(q);
        assert_eq!(params.get("code").map(String::as_str), Some("abc def"));
    }

    #[test]
    fn parse_query_handles_plus_as_space() {
        let q = "code=hello+world&state=s";
        let params = parse_query(q);
        assert_eq!(params.get("code").map(String::as_str), Some("hello world"));
    }

    #[test]
    fn parse_query_empty_string_returns_empty_map() {
        let params = parse_query("");
        assert!(params.is_empty());
    }

    #[test]
    fn parse_query_includes_valueless_key() {
        let params = parse_query("key_only");
        assert_eq!(params.get("key_only").map(String::as_str), Some(""));
    }

    #[test]
    fn parse_query_handles_utf8_percent_encoding() {
        let q = "error_description=%E4%B8%AD%E6%96%87&state=s";
        let params = parse_query(q);
        assert_eq!(params.get("error_description").map(String::as_str), Some("中文"));
    }

    #[test]
    fn parse_query_error_param_present() {
        let q = "error=access_denied&error_description=User+denied+access&state=s";
        let params = parse_query(q);
        assert_eq!(params.get("error").map(String::as_str), Some("access_denied"));
        assert_eq!(
            params.get("error_description").map(String::as_str),
            Some("User denied access")
        );
    }
}
