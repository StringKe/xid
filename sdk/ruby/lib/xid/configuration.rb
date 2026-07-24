# frozen_string_literal: true

module Xid
  # SDK 全局配置对象。
  # 通过 Xid.configure { |c| ... } 设置，或直接实例化用于多实例场景。
  class Configuration
    # XID issuer URL，例如 "https://xid.dev" 或自托管地址
    attr_accessor :issuer

    # JWKS endpoint URL；不填时自动从 issuer + "/jwks" 推导
    attr_accessor :jwks_uri

    # 期望的 audience（aud claim），通常是你的 client_id 或 API resource URL
    attr_accessor :audience

    # JWKS 缓存 TTL（秒），默认 3600
    attr_accessor :jwks_ttl

    # JWT clock skew 容忍秒数，默认 60
    attr_accessor :leeway

    # Webhook 签名密钥（whsec_ 前缀格式）
    attr_accessor :webhook_secret

    # Webhook 时间窗容忍秒数，默认 300
    attr_accessor :webhook_tolerance

    # cookie 中存放 access token 的键名，默认 "__xid_token"
    attr_accessor :cookie_name

    # webhook svix-id 去重 hook：返回 true 表示首次处理，false 表示已处理（重放拒绝）
    attr_accessor :message_id_store

    def initialize
      @issuer             = "https://xid.dev"
      @jwks_uri           = nil
      @audience           = nil
      @jwks_ttl           = 3600
      @leeway             = 60
      @webhook_secret     = nil
      @webhook_tolerance  = 300
      @cookie_name        = "__xid_token"
      @message_id_store   = nil
    end

    # 计算实际 JWKS endpoint URL（优先用显式配置，否则推导）
    def resolved_jwks_uri
      @jwks_uri || "#{@issuer.to_s.chomp("/")}/jwks"
    end

    def validate!
      raise ConfigurationError, "issuer must not be blank" if @issuer.to_s.strip.empty?
    end
  end
end
