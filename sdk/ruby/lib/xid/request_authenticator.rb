# frozen_string_literal: true

module Xid
  # 从 HTTP 请求提取并验证 access token，返回 AuthState。
  #
  # 提取优先级：
  #   1. Authorization: Bearer <token>（RFC 6750）
  #   2. cookie 名 __xid_token（可配置）
  #
  # 本类不抛异常 -- 所有失败以 AuthState.unauthenticated 返回，
  # 方便 Rack/Sinatra/Rails 中间件直接使用。
  class RequestAuthenticator
    # @param token_verifier  [Xid::TokenVerifier]
    # @param cookie_name     [String]  cookie 键名，默认 "__xid_token"
    def initialize(token_verifier:, cookie_name: "__xid_token")
      @verifier    = token_verifier
      @cookie_name = cookie_name
    end

    # 认证 Rack 风格请求对象（Rack::Request 或任何响应以下方法的对象）。
    #
    # 期望对象响应：
    #   #get_header(name)  -- 获取 HTTP header（Rack 标准接口）
    #   #cookies           -- Hash<String, String>（可选，用于 cookie 模式）
    #
    # 也可传入原始 Hash（Rack env）：
    #   authenticator.authenticate_env(env)
    #
    # @param request [#get_header, #cookies]
    # @return [Xid::AuthState]
    def authenticate(request)
      token = extract_bearer(request) || extract_cookie(request)
      return AuthState.unauthenticated("No token found in Authorization header or cookie") if token.nil?

      claims = @verifier.verify!(token)
      AuthState.authenticated(claims)
    rescue TokenVerificationError => e
      AuthState.unauthenticated(e.message)
    end

    # 直接从原始 Rack env Hash 认证（无需构建 Rack::Request）
    #
    # @param env [Hash] Rack env
    # @return [Xid::AuthState]
    def authenticate_env(env)
      token = extract_bearer_from_env(env) || extract_cookie_from_env(env)
      return AuthState.unauthenticated("No token found in Authorization header or cookie") if token.nil?

      claims = @verifier.verify!(token)
      AuthState.authenticated(claims)
    rescue TokenVerificationError => e
      AuthState.unauthenticated(e.message)
    end

    private

    # -- Bearer token 提取 -----------------------------------------------

    def extract_bearer(request)
      header = if request.respond_to?(:get_header)
                 request.get_header("HTTP_AUTHORIZATION")
               elsif request.respond_to?(:[])
                 request["HTTP_AUTHORIZATION"] || request["Authorization"]
               end

      parse_bearer(header)
    end

    def extract_bearer_from_env(env)
      header = env["HTTP_AUTHORIZATION"]
      parse_bearer(header)
    end

    def parse_bearer(header)
      return nil unless header.is_a?(String) && !header.empty?
      return nil unless header.length > 7 && header[0, 6].casecmp?("Bearer")
      return nil unless header.getbyte(6) == 32

      token_start = 7
      token_start += 1 while header.getbyte(token_start) == 32
      token = header[token_start..]&.strip
      token unless token.nil? || token.empty?
    end

    # -- Cookie 提取 -------------------------------------------------------

    def extract_cookie(request)
      return nil unless request.respond_to?(:cookies)

      cookies = request.cookies
      return nil unless cookies.is_a?(Hash)

      cookies[@cookie_name]
    end

    def extract_cookie_from_env(env)
      # 解析 Rack HTTP_COOKIE 字符串
      cookie_string = env["HTTP_COOKIE"].to_s
      return nil if cookie_string.empty?

      # 简单 key=value; key=value 解析
      pairs = cookie_string.split(/;\s*/)
      pairs.each do |pair|
        k, v = pair.split("=", 2)
        return CGI.unescape(v.to_s) if k.to_s.strip == @cookie_name
      end
      nil
    end
  end
end
