# frozen_string_literal: true

require "openssl"
require "base64"
require "time"

module Xid
  # Webhook 签名验证器。
  #
  # 协议（svix 风格，与 XID Webhook 规范对齐）：
  #
  #   svix-id:        唯一消息 ID，防重放核查用（可注入 message_id_store 去重）
  #   svix-timestamp: Unix 秒时间戳（字符串）
  #   svix-signature: "v1,<base64-HMAC-SHA256>" 可以有多个，逗号分隔（key 轮换）
  #
  # 签名消息格式："{svix-id}.{svix-timestamp}.{raw_body}"
  # 时间窗：默认 5 分钟，防重放。
  #
  # 使用 OpenSSL::HMAC（Ruby stdlib），无需额外依赖。
  class WebhookVerifier
    DEFAULT_TOLERANCE_SECONDS = 300 # 5 分钟
    LEGACY_HEX_SECRET = /\A[0-9a-f]{64}\z/

    # @param secret    [String]  Webhook 签名密钥（Base64 编码，Dashboard 中获取）
    #   例如 "whsec_AbCdEf..."（whsec_ 前缀会被自动剥除）
    # @param tolerance [Integer] 时间窗容忍秒数，默认 300
    # @param message_id_store [Proc, nil] svix-id 去重 hook，返回 true 表示首次处理
    def initialize(secret:, tolerance: DEFAULT_TOLERANCE_SECONDS, message_id_store: nil)
      raw = secret.to_s
      @secret = if !raw.start_with?("whsec_") && LEGACY_HEX_SECRET.match?(raw)
                  raw.b
                else
                  Base64.strict_decode64(raw.delete_prefix("whsec_"))
                end
      @tolerance = tolerance
      @message_id_store = message_id_store
    rescue ArgumentError => e
      raise ConfigurationError, "Invalid webhook secret (not valid Base64): #{e.message}"
    end

    # 验证 Webhook 请求。
    # 成功返回解析后的 body Hash；失败抛 Xid::WebhookVerificationError。
    #
    # @param headers [Hash<String, String>]  HTTP headers（key 大小写不敏感）
    # @param raw_body [String]               原始请求体（字节字符串，未 JSON.parse）
    # @return [Hash]                         解析后的 JSON payload
    def verify!(headers, raw_body)
      headers = normalize_headers(headers)

      msg_id    = require_header!(headers, "svix-id")
      timestamp = require_header!(headers, "svix-timestamp")
      sigs_raw  = require_header!(headers, "svix-signature")

      validate_timestamp!(timestamp)

      signed_content = "#{msg_id}.#{timestamp}.#{raw_body}"
      expected_sig   = compute_signature(signed_content)

      # 支持多签名（密钥轮换期并行验证）
      signatures = parse_signatures(sigs_raw)
      raise WebhookVerificationError, "No valid signatures in svix-signature header" if signatures.empty?

      verified = signatures.any? do |sig|
        secure_compare(sig, expected_sig)
      end

      raise WebhookVerificationError, "Webhook signature verification failed" unless verified

      if @message_id_store && !@message_id_store.call(msg_id)
        raise WebhookVerificationError,
              "Webhook svix-id #{msg_id.inspect} has already been processed"
      end

      # 签名通过后才解析 JSON，防止 JSON bomb 在校验前处理
      JSON.parse(raw_body)
    rescue WebhookVerificationError, ConfigurationError
      raise
    rescue JSON::ParserError => e
      raise WebhookVerificationError, "Webhook body is not valid JSON: #{e.message}"
    end

    private

    def normalize_headers(headers)
      headers.transform_keys { |k| k.to_s.downcase }
    end

    def require_header!(headers, name)
      value = headers[name.downcase].to_s.strip
      raise WebhookVerificationError, "Missing required header: #{name}" if value.empty?

      value
    end

    def validate_timestamp!(timestamp_str)
      ts = Integer(timestamp_str)
      delta = (Time.now.to_i - ts).abs
      return if delta <= @tolerance

      raise WebhookVerificationError,
            "Webhook timestamp out of tolerance window " \
            "(delta=#{delta}s, tolerance=#{@tolerance}s). Possible replay attack."
    rescue ArgumentError
      raise WebhookVerificationError, "svix-timestamp is not a valid integer: #{timestamp_str.inspect}"
    end

    def compute_signature(signed_content)
      OpenSSL::HMAC.digest("SHA256", @secret, signed_content)
    end

    # 解析 "v1,<base64sig1> v1,<base64sig2>" 格式，返回 raw bytes Array
    def parse_signatures(sigs_raw)
      sigs_raw.split(/\s+/).each_with_object([]) do |item, acc|
        version, encoded = item.split(",", 2)
        next unless version == "v1" && encoded

        begin
          acc << Base64.strict_decode64(encoded)
        rescue ArgumentError
          # skip malformed base64
        end
      end
    end

    # 常量时间比较（防 timing attack）。
    # Ruby 2.7+ 优先用 OpenSSL.fixed_length_secure_compare；
    # 2.6 fallback 到 XOR 比较（仍需 bytesize 相同保证时间均一）。
    def secure_compare(a, b)
      return false unless a.bytesize == b.bytesize

      if OpenSSL.respond_to?(:fixed_length_secure_compare)
        OpenSSL.fixed_length_secure_compare(a, b)
      else
        # XOR 每个字节后 OR 累积：任意字节不同则 result 非零
        result = 0
        a.bytes.zip(b.bytes) { |x, y| result |= (x ^ y) }
        result.zero?
      end
    end
  end
end
