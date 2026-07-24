# frozen_string_literal: true

require "openssl"
require "base64"
require "json"

module Xid
  # JWT access token 验证器（纯 stdlib 实现，不依赖 jwt gem）。
  #
  # 支持算法：ES256（主），RS256（兼容）。
  # 验证项：签名、iss、aud、exp、nbf、leeway。
  # 密钥来源：JwksCache，公钥为 OpenSSL::PKey::EC 或 OpenSSL::PKey::RSA 实例。
  class TokenVerifier
    # 允许的算法白名单，禁止 none/HS256 等对称/无签名算法
    ALLOWED_ALGORITHMS = %w[ES256 RS256].freeze

    # @param jwks_cache [Xid::JwksCache]
    # @param issuer     [String]   期望的 iss 值，例如 "https://xid.dev"
    # @param audience   [String, Array<String>, nil]
    #   期望的 aud；nil 跳过 aud 校验
    # @param leeway     [Integer]  clock skew 容忍秒数，默认 60
    def initialize(jwks_cache:, issuer:, audience: nil, leeway: 60)
      @jwks_cache = jwks_cache
      @issuer     = issuer
      @audience   = audience
      @leeway     = leeway
    end

    # 验证 JWT 字符串，返回 Claims 对象。
    # 验证失败抛出 Xid::TokenVerificationError。
    #
    # @param token [String]
    # @return [Xid::Claims]
    def verify!(token)
      parts = token.to_s.split(".")
      raise TokenVerificationError, "Malformed JWT: expected 3 segments" unless parts.length == 3

      header  = parse_segment(parts[0], "header")
      payload = parse_segment(parts[1], "payload")
      alg     = header["alg"].to_s
      kid     = header["kid"]

      validate_algorithm!(alg)

      public_keys = @jwks_cache.keys(kid: kid)
      raise TokenVerificationError, "No matching JWKS key found for kid=#{kid.inspect}" if public_keys.empty?

      signing_input = "#{parts[0]}.#{parts[1]}"
      raw_sig       = b64url_decode(parts[2])

      verified = public_keys.any? do |pkey|
        verify_signature(alg, pkey, signing_input, raw_sig)
      end

      raise TokenVerificationError, "JWT signature verification failed" unless verified

      validate_claims!(payload)
      Claims.new(payload)
    rescue TokenVerificationError
      raise
    rescue => e
      raise TokenVerificationError, "Unexpected error during JWT verification: #{e.message}"
    end

    private

    def b64url_decode(str)
      padded = str + "=" * ((4 - str.length % 4) % 4)
      Base64.strict_decode64(padded.tr("-_", "+/"))
    rescue ArgumentError => e
      raise TokenVerificationError, "Invalid base64url encoding: #{e.message}"
    end

    def parse_segment(segment, name)
      JSON.parse(b64url_decode(segment))
    rescue JSON::ParserError => e
      raise TokenVerificationError, "Malformed JWT #{name}: #{e.message}"
    end

    def validate_algorithm!(alg)
      return if ALLOWED_ALGORITHMS.include?(alg)

      raise TokenVerificationError,
            "Unsupported algorithm #{alg.inspect}. Allowed: #{ALLOWED_ALGORITHMS.join(", ")}"
    end

    # 根据 alg 选择 OpenSSL digest 并执行验签。
    # raw_sig 为 JWT 规范的 R||S 格式（ES256:64 bytes）或 PKCS1 格式（RS256）。
    def verify_signature(alg, pkey, signing_input, raw_sig)
      digest = OpenSSL::Digest::SHA256.new

      case alg
      when "ES256"
        # JWT ES256 签名为 raw R||S（各 32 bytes），需转成 ASN.1 DER 再给 OpenSSL 验签
        der_sig = p1363_to_der(raw_sig)
        pkey.verify(digest, der_sig, signing_input)
      when "RS256"
        pkey.verify(digest, raw_sig, signing_input)
      else
        false
      end
    rescue OpenSSL::PKey::PKeyError
      false
    end

    # IEEE P1363 格式（R||S 各 32 bytes）转 ASN.1 DER Sequence
    def p1363_to_der(raw)
      raise TokenVerificationError, "ES256 signature must be 64 bytes" unless raw.bytesize == 64

      r_bytes = raw.byteslice(0, 32)
      s_bytes = raw.byteslice(32, 32)

      asn1_seq = OpenSSL::ASN1::Sequence([
        OpenSSL::ASN1::Integer(OpenSSL::BN.new(r_bytes, 2)),
        OpenSSL::ASN1::Integer(OpenSSL::BN.new(s_bytes, 2))
      ])
      asn1_seq.to_der
    end

    def validate_claims!(payload)
      now = Time.now.to_i

      iss = payload["iss"]
      raise TokenVerificationError, "Token missing iss claim" if iss.nil?
      if iss != @issuer
        raise TokenVerificationError, "Token issuer #{iss.inspect} does not match expected #{@issuer.inspect}"
      end

      exp = payload["exp"]
      raise TokenVerificationError, "Token missing exp claim" if exp.nil?
      if now > exp + @leeway
        raise TokenVerificationError, "Token has expired (exp=#{exp}, now=#{now})"
      end

      nbf = payload["nbf"]
      if nbf && now < nbf - @leeway
        raise TokenVerificationError, "Token not yet valid (nbf=#{nbf}, now=#{now})"
      end

      return if @audience.nil?

      aud = payload["aud"]
      audiences = Array(aud)
      expected  = Array(@audience)
      return if (expected & audiences).any?

      raise TokenVerificationError,
            "Token audience #{aud.inspect} does not match expected #{@audience.inspect}"
    end
  end
end
