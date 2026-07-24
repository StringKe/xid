# frozen_string_literal: true

require "base64"
require "cgi"
require "json"
require "openssl"
require "net/http"
require "uri"

require_relative "xid/version"
require_relative "xid/errors"
require_relative "xid/configuration"
require_relative "xid/claims"
require_relative "xid/auth_state"
require_relative "xid/jwks_cache"
require_relative "xid/token_verifier"
require_relative "xid/request_authenticator"
require_relative "xid/webhook_verifier"
require_relative "xid/client"

# XID Identity Platform -- Ruby 服务端 SDK
#
# Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
#
# 用法（全局单实例）：
#
#   Xid.configure do |c|
#     c.issuer         = "https://xid.dev"
#     c.audience       = "your_client_id"
#     c.webhook_secret = "whsec_..."
#   end
#
#   # 验证 token
#   claims = Xid.verify_token(token)
#   puts claims.sub
#
#   # 认证 Rack 请求
#   auth = Xid.authenticate_request(request)
#   return [401, {}, ["Unauthorized"]] unless auth.signed_in?
#
#   # 验证 Webhook
#   payload = Xid.verify_webhook(request.headers, request.raw_post)
#
module Xid
  class << self
    # 全局 Configuration 实例（懒初始化）
    def configuration
      @configuration ||= Configuration.new
    end

    # 配置块入口
    # @yield [Xid::Configuration]
    def configure
      yield configuration
      # 配置改变后重建默认 client
      @default_client = nil
    end

    # 全局默认 Client（懒初始化，configure 之后首次调用时构建）
    def default_client
      @default_client ||= Client.new(configuration)
    end

    # 快捷方法：验证 access token
    # @param token [String]
    # @return [Xid::Claims]
    def verify_token(token)
      default_client.verify_token(token)
    end

    # 快捷方法：认证 Rack 请求
    # @param request_or_env [#get_header | Hash]
    # @return [Xid::AuthState]
    def authenticate_request(request_or_env)
      default_client.authenticate_request(request_or_env)
    end

    # 快捷方法：验证 Webhook
    # @param headers  [Hash]
    # @param raw_body [String]
    # @return [Hash]
    def verify_webhook(headers, raw_body)
      default_client.verify_webhook(headers, raw_body)
    end

    # 重置全局状态（测试用）
    def reset!
      @configuration  = nil
      @default_client = nil
    end
  end
end
