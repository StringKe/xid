# frozen_string_literal: true

require "spec_helper"
require "openssl"
require "base64"
require "json"
require "time"

RSpec.describe Xid::WebhookVerifier do
  # 生成测试用密钥（32 字节随机，Base64 编码加 whsec_ 前缀）
  let(:raw_key)     { OpenSSL::Random.random_bytes(32) }
  let(:secret)      { "whsec_#{Base64.strict_encode64(raw_key)}" }
  let(:verifier)    { described_class.new(secret: secret) }

  let(:msg_id)      { "msg_01HZ3Q0000000000000000000" }
  let(:body_hash)   { { "type" => "user.created", "data" => { "id" => "usr_123" } } }
  let(:raw_body)    { JSON.generate(body_hash) }
  let(:timestamp)   { Time.now.to_i.to_s }

  let(:signed_content) { "#{msg_id}.#{timestamp}.#{raw_body}" }
  let(:sig_bytes)      { OpenSSL::HMAC.digest("SHA256", raw_key, signed_content) }
  let(:sig_header)     { "v1,#{Base64.strict_encode64(sig_bytes)}" }

  let(:headers) do
    {
      "svix-id"        => msg_id,
      "svix-timestamp" => timestamp,
      "svix-signature" => sig_header
    }
  end

  describe "#verify!" do
    it "returns parsed payload when signature is valid" do
      result = verifier.verify!(headers, raw_body)
      expect(result).to eq(body_hash)
    end

    it "treats a legacy 64-character lowercase hex secret as UTF-8 key material" do
      legacy_secret = "ab" * 32
      legacy_verifier = described_class.new(secret: legacy_secret)
      legacy_sig = OpenSSL::HMAC.digest("SHA256", legacy_secret, signed_content)
      legacy_headers = headers.merge("svix-signature" => "v1,#{Base64.strict_encode64(legacy_sig)}")

      result = legacy_verifier.verify!(legacy_headers, raw_body)

      expect(result).to eq(body_hash)
    end

    it "raises WebhookVerificationError when signature does not match" do
      bad_headers = headers.merge("svix-signature" => "v1,#{Base64.strict_encode64("bad_sig_bytes_pad")}")
      expect { verifier.verify!(bad_headers, raw_body) }
        .to raise_error(Xid::WebhookVerificationError, /signature verification failed/i)
    end

    it "raises WebhookVerificationError when timestamp is outside tolerance window" do
      old_ts      = (Time.now.to_i - 400).to_s
      old_content = "#{msg_id}.#{old_ts}.#{raw_body}"
      old_sig     = "v1,#{Base64.strict_encode64(OpenSSL::HMAC.digest("SHA256", raw_key, old_content))}"
      old_headers = headers.merge("svix-timestamp" => old_ts, "svix-signature" => old_sig)

      expect { verifier.verify!(old_headers, raw_body) }
        .to raise_error(Xid::WebhookVerificationError, /tolerance window/i)
    end

    it "raises WebhookVerificationError when svix-id header is missing" do
      expect { verifier.verify!(headers.except("svix-id"), raw_body) }
        .to raise_error(Xid::WebhookVerificationError, /svix-id/i)
    end

    it "accepts multiple signatures in svix-signature (key rotation)" do
      other_key    = OpenSSL::Random.random_bytes(32)
      other_sig    = "v1,#{Base64.strict_encode64(OpenSSL::HMAC.digest("SHA256", other_key, signed_content))}"
      multi_header = "#{other_sig} #{sig_header}"
      multi_headers = headers.merge("svix-signature" => multi_header)

      result = verifier.verify!(multi_headers, raw_body)
      expect(result).to eq(body_hash)
    end
  end
end
