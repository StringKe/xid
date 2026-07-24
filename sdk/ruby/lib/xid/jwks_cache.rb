# frozen_string_literal: true

require "net/http"
require "uri"
require "openssl"
require "json"
require "base64"

module Xid
  # JWKS 缓存层：从 issuer 的 /jwks endpoint 拉取公钥（EC/RSA），
  # 返回 OpenSSL::PKey 实例，默认缓存 TTL 3600 秒（与服务端 KV 缓存对齐）。
  # 线程安全：Mutex 保护读写。
  # 纯 stdlib 实现：不依赖 faraday 或 jwt gem。
  class JwksCache
    DEFAULT_TTL = 3600

    # @param jwks_uri    [String]   JWKS endpoint URL
    # @param ttl         [Integer]  缓存有效期（秒），默认 3600
    # @param http_timeout [Integer] HTTP 读超时（秒），默认 10
    def initialize(jwks_uri:, ttl: DEFAULT_TTL, http_timeout: 10)
      @jwks_uri     = jwks_uri
      @ttl          = ttl
      @http_timeout = http_timeout
      @mutex        = Mutex.new
      # kid -> Array<OpenSSL::PKey>
      @key_map      = {}
      @cached_at    = nil
    end

    # 返回与 kid 匹配的 OpenSSL::PKey 公钥数组。
    # kid 为 nil 时返回全部公钥。
    # 若缓存过期则重新拉取；kid 不在缓存时强制刷新一次（密钥轮换期）。
    #
    # @param kid [String, nil]
    # @return [Array<OpenSSL::PKey>]
    def keys(kid: nil)
      @mutex.synchronize { refresh_if_stale! }

      matched = filter_keys(kid)
      if matched.empty? && kid
        @mutex.synchronize { fetch! }
        matched = filter_keys(kid)
      end

      matched
    end

    # 手动清除缓存（测试用）
    def invalidate!
      @mutex.synchronize do
        @key_map   = {}
        @cached_at = nil
      end
    end

    private

    def refresh_if_stale!
      return if @cached_at && (Time.now.to_i - @cached_at) < @ttl

      fetch!
    end

    def fetch!
      uri  = URI.parse(@jwks_uri)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl       = uri.scheme == "https"
      http.read_timeout  = @http_timeout
      http.open_timeout  = @http_timeout
      # 验证 TLS 证书（生产必须）
      http.verify_mode   = OpenSSL::SSL::VERIFY_PEER

      resp = http.get(uri.path.empty? ? "/" : uri.path)
      raise JwksError, "JWKS fetch failed: HTTP #{resp.code}" unless resp.is_a?(Net::HTTPSuccess)

      body = JSON.parse(resp.body)
      jwks_keys = body["keys"]
      raise JwksError, "JWKS response missing 'keys' array" unless jwks_keys.is_a?(Array)

      new_map = {}
      jwks_keys.each do |key_data|
        next unless key_data.is_a?(Hash)

        kid = key_data["kid"].to_s
        pkey = parse_jwk(key_data)
        next if pkey.nil?

        new_map[kid] ||= []
        new_map[kid] << pkey
      end

      @key_map   = new_map
      @cached_at = Time.now.to_i
    rescue Net::OpenTimeout, Net::ReadTimeout, SocketError => e
      raise JwksError, "JWKS network error: #{e.message}"
    rescue JSON::ParserError => e
      raise JwksError, "JWKS parse error: #{e.message}"
    end

    def filter_keys(kid)
      return @key_map.values.flatten if kid.nil?

      @key_map[kid.to_s] || []
    end

    # JWK オブジェクト -> OpenSSL::PKey（EC P-256 または RSA）
    def parse_jwk(key_data)
      kty = key_data["kty"].to_s
      case kty
      when "EC"
        parse_ec_jwk(key_data)
      when "RSA"
        parse_rsa_jwk(key_data)
      end
    rescue OpenSSL::PKey::ECError, OpenSSL::PKey::RSAError, ArgumentError
      nil
    end

    # EC JWK（P-256）: crv=P-256, x, y（base64url）-> OpenSSL::PKey::EC 公钥
    def parse_ec_jwk(key_data)
      crv = key_data["crv"].to_s
      # 只支持 P-256（ES256 对应 prime256v1）
      raise ArgumentError, "Unsupported EC curve: #{crv}" unless crv == "P-256"

      x_bytes = b64url_decode(key_data["x"].to_s)
      y_bytes = b64url_decode(key_data["y"].to_s)

      # 非压缩点格式: 0x04 || X || Y
      point_bytes = "\x04".b + x_bytes + y_bytes

      group = OpenSSL::PKey::EC::Group.new("prime256v1")
      point = OpenSSL::PKey::EC::Point.new(group, OpenSSL::BN.new(point_bytes, 2))

      key = OpenSSL::PKey::EC.new(group)
      key.public_key = point
      key
    end

    # RSA JWK: n, e（base64url）-> OpenSSL::PKey::RSA 公钥
    def parse_rsa_jwk(key_data)
      n_bytes = b64url_decode(key_data["n"].to_s)
      e_bytes = b64url_decode(key_data["e"].to_s)

      n_bn = OpenSSL::BN.new(n_bytes, 2)
      e_bn = OpenSSL::BN.new(e_bytes, 2)

      # Ruby 2.7+: OpenSSL::PKey::RSA.new(n_bn, e_bn) 弃用
      # 兼容 Ruby 2.6 的方式：构造 ASN.1 DER 再 decode
      asn1 = OpenSSL::ASN1::Sequence([
        OpenSSL::ASN1::Integer(n_bn),
        OpenSSL::ASN1::Integer(e_bn)
      ])
      OpenSSL::PKey::RSA.new(asn1.to_der)
    end

    def b64url_decode(str)
      padded = str + "=" * ((4 - str.length % 4) % 4)
      Base64.strict_decode64(padded.tr("-_", "+/"))
    end
  end
end
