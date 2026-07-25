# frozen_string_literal: true

module Xid
  # SDK 根异常。所有 SDK 抛出的异常均继承此类，
  # 方便调用方统一 rescue Xid::Error。
  class Error < StandardError; end

  # JWT 验证失败（签名错误、过期、claims 不符等）。
  class TokenVerificationError < Error; end

  # 从 JWKS endpoint 拉取密钥失败（网络或 HTTP 状态异常）。
  class JwksError < Error; end

  # Webhook 签名验证失败（签名不匹配或时间窗过期）。
  class WebhookVerificationError < Error; end

  # 配置缺失或非法（如 issuer 为空）。
  class ConfigurationError < Error; end
end
