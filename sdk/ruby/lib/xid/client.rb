# frozen_string_literal: true

module Xid
  # 高层门面：持有已初始化的各个验证器，提供统一入口。
  # 单实例场景通过 Xid.configure + Xid::Client.default 使用；
  # 多实例场景（多 issuer）直接 Xid::Client.new(config) 构造独立实例。
  class Client
    attr_reader :configuration, :jwks_cache, :token_verifier, :request_authenticator

    # @param configuration [Xid::Configuration]
    def initialize(configuration)
      configuration.validate!

      @configuration = configuration
      @jwks_cache = JwksCache.new(
        jwks_uri: configuration.resolved_jwks_uri,
        ttl:      configuration.jwks_ttl
      )
      @token_verifier = TokenVerifier.new(
        jwks_cache: @jwks_cache,
        issuer:     configuration.issuer,
        audience:   configuration.audience,
        leeway:     configuration.leeway
      )
      @request_authenticator = RequestAuthenticator.new(
        token_verifier: @token_verifier,
        cookie_name:    configuration.cookie_name
      )
      if configuration.webhook_secret
        @webhook_verifier = WebhookVerifier.new(
          secret:             configuration.webhook_secret,
          tolerance:          configuration.webhook_tolerance,
          message_id_store:   configuration.message_id_store
        )
      end
    end

    # -- JWT / token ---------------------------------------------------------

    # 验证 access token 字符串，返回 Claims。
    # 失败抛 Xid::TokenVerificationError。
    #
    # @param token [String]
    # @return [Xid::Claims]
    def verify_token(token)
      @token_verifier.verify!(token)
    end

    # -- 请求认证 ------------------------------------------------------------

    # 从 Rack request 对象或 Rack env Hash 中提取并验证 token，返回 AuthState。
    # 本方法不抛异常。
    #
    # @param request_or_env [#get_header | Hash]
    # @return [Xid::AuthState]
    def authenticate_request(request_or_env)
      if request_or_env.is_a?(Hash)
        @request_authenticator.authenticate_env(request_or_env)
      else
        @request_authenticator.authenticate(request_or_env)
      end
    end

    def exchange_session_token(incoming_request_url:, cookie_header:, endpoint: nil, transport: nil)
      SessionTokenExchange.exchange(
        incoming_request_url: incoming_request_url,
        cookie_header: cookie_header,
        endpoint: endpoint,
        transport: transport
      )
    end

    # -- Webhook 验证 --------------------------------------------------------

    # 验证 Webhook 请求。需要在 Configuration 中设置 webhook_secret。
    # 成功返回 payload Hash；失败抛 Xid::WebhookVerificationError。
    #
    # @param headers  [Hash]   HTTP headers
    # @param raw_body [String] 原始请求体（字节字符串）
    # @return [Hash]
    def verify_webhook(headers, raw_body)
      raise ConfigurationError, "webhook_secret not configured" unless @webhook_verifier

      @webhook_verifier.verify!(headers, raw_body)
    end
  end
end
