# frozen_string_literal: true

require "spec_helper"
require "jwt"
require "openssl"
require "json"

RSpec.describe Xid::TokenVerifier do
  let(:issuer)   { "https://xid.dev" }
  let(:audience) { "my_client_id" }
  let(:kid)      { "key-001" }

  # 生成 ES256 密钥对（测试用）
  let(:ec_key)    { OpenSSL::PKey::EC.generate("prime256v1") }
  let(:pub_key)   { ec_key.public_key }

  let(:jwk)       { JWT::JWK.new(ec_key, kid: kid) }
  let(:jwks_data) { { keys: [jwk.export(include_private: false)] }.to_json }

  let(:jwks_cache) do
    cache = instance_double(Xid::JwksCache)
    allow(cache).to receive(:keys).with(kid: kid).and_return([jwk])
    allow(cache).to receive(:keys).with(kid: nil).and_return([jwk])
    cache
  end

  let(:verifier) do
    described_class.new(jwks_cache: jwks_cache, issuer: issuer, audience: audience)
  end

  def build_token(overrides = {})
    payload = {
      sub:       "usr_123",
      iss:       issuer,
      aud:       audience,
      exp:       Time.now.to_i + 3600,
      iat:       Time.now.to_i,
      jti:       "jti_abc",
      client_id: "my_client_id"
    }.merge(overrides)

    JWT.encode(payload, ec_key, "ES256", { kid: kid })
  end

  describe "#verify!" do
    it "returns Claims for a valid token" do
      token  = build_token
      claims = verifier.verify!(token)

      expect(claims).to be_a(Xid::Claims)
      expect(claims.sub).to eq("usr_123")
      expect(claims.iss).to eq(issuer)
    end

    it "raises TokenVerificationError for an expired token" do
      token = build_token(exp: Time.now.to_i - 7200)
      expect { verifier.verify!(token) }
        .to raise_error(Xid::TokenVerificationError)
    end

    it "raises TokenVerificationError for wrong issuer" do
      token = build_token(iss: "https://evil.example.com")
      expect { verifier.verify!(token) }
        .to raise_error(Xid::TokenVerificationError)
    end

    it "raises TokenVerificationError for wrong audience" do
      token = build_token(aud: "other_client")
      expect { verifier.verify!(token) }
        .to raise_error(Xid::TokenVerificationError)
    end

    it "raises TokenVerificationError when algorithm is none" do
      # none 算法不在白名单
      token = JWT.encode({ sub: "usr_123", iss: issuer, aud: audience, exp: Time.now.to_i + 3600 }, nil, "none")
      expect { verifier.verify!(token) }
        .to raise_error(Xid::TokenVerificationError)
    end

    it "raises TokenVerificationError when no JWKS key matches kid" do
      allow(jwks_cache).to receive(:keys).and_return([])
      token = build_token
      expect { verifier.verify!(token) }
        .to raise_error(Xid::TokenVerificationError, /No matching JWKS key/i)
    end
  end
end
