# frozen_string_literal: true

require "minitest/autorun"
require "openssl"
require "base64"
require "json"

# Load the SDK from lib/ (passed via -Ilib)
require "xid"

# Load remaining test files from ARGV when the glob pattern passes multiple
# *_test.rb files to a single ruby invocation (e.g. ruby -Ilib -Itest test/*_test.rb).
# Guard ensures each file is only loaded once.
if !defined?(XID_TEST_SUITE_LOADED)
  XID_TEST_SUITE_LOADED = true # rubocop:disable Style/MutableConstant
  # ARGV contains the remaining files not yet loaded as the script
  ARGV.select { |f| f.end_with?("_test.rb") }.each do |path|
    full = File.expand_path(path)
    require full unless $LOADED_FEATURES.include?(full)
  end
end

module TestHelpers
  # Build a JWT signed with the given OpenSSL::PKey::EC key using ES256.
  # Returns the raw JWT string.
  def self.build_jwt_es256(key, payload:, header_overrides: {})
    header = { "alg" => "ES256", "typ" => "JWT", "kid" => "test-kid" }.merge(header_overrides)
    h = b64url_encode(JSON.generate(header))
    p = b64url_encode(JSON.generate(payload))
    signing_input = "#{h}.#{p}"

    der_sig = key.sign(OpenSSL::Digest::SHA256.new, signing_input)
    raw_sig = der_to_p1363(der_sig)
    "#{signing_input}.#{b64url_encode(raw_sig)}"
  end

  # Build a JWT signed with an OpenSSL::PKey::RSA key using RS256.
  def self.build_jwt_rs256(key, payload:, header_overrides: {})
    header = { "alg" => "RS256", "typ" => "JWT", "kid" => "rsa-kid" }.merge(header_overrides)
    h = b64url_encode(JSON.generate(header))
    p = b64url_encode(JSON.generate(payload))
    signing_input = "#{h}.#{p}"

    raw_sig = key.sign(OpenSSL::Digest::SHA256.new, signing_input)
    "#{signing_input}.#{b64url_encode(raw_sig)}"
  end

  # Build a JWT with the given alg header but a garbage/absent signature.
  # Used to test algorithm rejection before signature verification.
  def self.build_jwt_with_alg(payload, alg:)
    header = { "alg" => alg, "typ" => "JWT" }
    h = b64url_encode(JSON.generate(header))
    p = b64url_encode(JSON.generate(payload))
    # Provide a dummy (non-empty) third segment so split(".") gives 3 parts
    "#{h}.#{p}.#{b64url_encode("fakesig")}"
  end

  def self.b64url_encode(s)
    Base64.strict_encode64(s).tr("+/", "-_").gsub("=", "")
  end

  # ASN.1 DER (R,S integers) -> IEEE P1363 R||S (32+32 bytes)
  def self.der_to_p1363(der_sig)
    asn1 = OpenSSL::ASN1.decode(der_sig)
    r_bytes = asn1.value[0].value.to_s(2)
    s_bytes = asn1.value[1].value.to_s(2)
    pad32 = ->(b) { ("\x00" * 32 + b).bytes.last(32).pack("C*") }
    pad32.call(r_bytes) + pad32.call(s_bytes)
  end

  # Build a mock JWKS cache backed by an in-memory key map.
  # Accepts kid -> OpenSSL::PKey
  def self.mock_jwks_cache(key_map)
    MockJwksCache.new(key_map)
  end

  class MockJwksCache
    def initialize(key_map)
      # Normalize: each value must be an Array of public keys
      @key_map = key_map.transform_keys(&:to_s).transform_values do |v|
        Array(v)
      end
    end

    def keys(kid: nil)
      return @key_map.values.flatten if kid.nil?

      @key_map[kid.to_s] || []
    end

    def invalidate!
      # no-op for tests
    end
  end
end
