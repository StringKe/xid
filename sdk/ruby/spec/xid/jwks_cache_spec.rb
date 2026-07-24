# frozen_string_literal: true

require "spec_helper"
require "json"
require "openssl"
require "jwt"

RSpec.describe Xid::JwksCache do
  let(:jwks_uri) { "https://xid.dev/jwks" }
  let(:kid)      { "key-001" }
  let(:ec_key)   { OpenSSL::PKey::EC.generate("prime256v1") }
  let(:jwk)      { JWT::JWK.new(ec_key, kid: kid) }
  let(:jwks_json) do
    { keys: [jwk.export(include_private: false)] }.to_json
  end

  let(:cache) { described_class.new(jwks_uri: jwks_uri) }

  before do
    stub_request(:get, jwks_uri)
      .to_return(status: 200, body: jwks_json, headers: { "Content-Type" => "application/json" })
  end

  describe "#keys" do
    it "fetches JWKS on first call and returns matching key" do
      keys = cache.keys(kid: kid)
      expect(keys).not_to be_empty
      expect(keys.first[:kid]).to eq(kid)
    end

    it "does not make a second HTTP request within TTL" do
      cache.keys(kid: kid)
      cache.keys(kid: kid)
      expect(WebMock).to have_requested(:get, jwks_uri).once
    end

    it "raises JwksError on HTTP failure" do
      stub_request(:get, jwks_uri).to_return(status: 503, body: "")
      fresh_cache = described_class.new(jwks_uri: jwks_uri)
      expect { fresh_cache.keys }.to raise_error(Xid::JwksError, /HTTP 503/)
    end

    it "re-fetches when kid is not cached (key rotation)" do
      new_ec_key  = OpenSSL::PKey::EC.generate("prime256v1")
      new_jwk     = JWT::JWK.new(new_ec_key, kid: "key-002")
      new_jwks    = { keys: [jwk.export(include_private: false), new_jwk.export(include_private: false)] }.to_json

      stub_request(:get, jwks_uri)
        .to_return(
          { status: 200, body: jwks_json,  headers: { "Content-Type" => "application/json" } },
          { status: 200, body: new_jwks,   headers: { "Content-Type" => "application/json" } }
        )

      cache.keys(kid: kid)              # 第一次，只有 key-001
      keys = cache.keys(kid: "key-002") # kid 不在缓存 -> 强制刷新
      expect(keys.map { |k| k[:kid] }).to include("key-002")
    end
  end
end
