# frozen_string_literal: true

require_relative "test_helper"

class WebhookVerifierTest < Minitest::Test
  def setup
    @raw_key  = OpenSSL::Random.random_bytes(32)
    @secret   = "whsec_#{Base64.strict_encode64(@raw_key)}"
    @verifier = Xid::WebhookVerifier.new(secret: @secret)

    @msg_id    = "msg_01HZ3Q0000000000000000000"
    @body_hash = { "type" => "user.created", "data" => { "id" => "usr_123" } }
    @raw_body  = JSON.generate(@body_hash)
    @timestamp = Time.now.to_i.to_s
  end

  def make_sig(msg_id, timestamp, raw_body, key = @raw_key)
    content = "#{msg_id}.#{timestamp}.#{raw_body}"
    hmac    = OpenSSL::HMAC.digest("SHA256", key, content)
    "v1,#{Base64.strict_encode64(hmac)}"
  end

  def valid_headers(overrides = {})
    {
      "svix-id"        => @msg_id,
      "svix-timestamp" => @timestamp,
      "svix-signature" => make_sig(@msg_id, @timestamp, @raw_body)
    }.merge(overrides)
  end

  # --- Happy path -------------------------------------------------------------

  def test_verify_valid_signature_returns_payload
    result = @verifier.verify!(valid_headers, @raw_body)
    assert_equal @body_hash, result
  end

  def test_verify_with_whsec_prefix_stripped
    verifier = Xid::WebhookVerifier.new(secret: @secret)
    result   = verifier.verify!(valid_headers, @raw_body)
    assert_equal @body_hash, result
  end

  # --- Header normalization ---------------------------------------------------

  def test_verify_case_insensitive_headers
    upcased = {
      "SVIX-ID"        => @msg_id,
      "SVIX-TIMESTAMP" => @timestamp,
      "SVIX-SIGNATURE" => make_sig(@msg_id, @timestamp, @raw_body)
    }
    result = @verifier.verify!(upcased, @raw_body)
    assert_equal @body_hash, result
  end

  # --- Timestamp validation ---------------------------------------------------

  def test_raises_when_timestamp_too_old
    old_ts      = (Time.now.to_i - 400).to_s
    old_sig     = make_sig(@msg_id, old_ts, @raw_body)
    old_headers = { "svix-id" => @msg_id, "svix-timestamp" => old_ts, "svix-signature" => old_sig }

    err = assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(old_headers, @raw_body) }
    assert_match(/tolerance window/, err.message)
  end

  def test_raises_when_timestamp_in_future_beyond_tolerance
    future_ts  = (Time.now.to_i + 400).to_s
    future_sig = make_sig(@msg_id, future_ts, @raw_body)
    headers    = { "svix-id" => @msg_id, "svix-timestamp" => future_ts, "svix-signature" => future_sig }

    err = assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(headers, @raw_body) }
    assert_match(/tolerance window/, err.message)
  end

  def test_raises_on_non_integer_timestamp
    bad_headers = valid_headers("svix-timestamp" => "not-a-number")
    assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(bad_headers, @raw_body) }
  end

  # --- Missing headers --------------------------------------------------------

  def test_raises_when_svix_id_missing
    headers = valid_headers.reject { |k, _| k == "svix-id" }
    err     = assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(headers, @raw_body) }
    assert_match(/svix-id/, err.message)
  end

  def test_raises_when_svix_timestamp_missing
    headers = valid_headers.reject { |k, _| k == "svix-timestamp" }
    assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(headers, @raw_body) }
  end

  def test_raises_when_svix_signature_missing
    headers = valid_headers.reject { |k, _| k == "svix-signature" }
    assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(headers, @raw_body) }
  end

  # --- Signature mismatch -----------------------------------------------------

  def test_raises_when_signature_does_not_match
    bad_sig     = "v1,#{Base64.strict_encode64("bad_sig_bytes_pad" * 2)}"
    bad_headers = valid_headers("svix-signature" => bad_sig)

    err = assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(bad_headers, @raw_body) }
    assert_match(/signature verification failed/, err.message)
  end

  # --- Multiple signatures (key rotation) ------------------------------------

  def test_accepts_one_of_multiple_signatures
    other_key  = OpenSSL::Random.random_bytes(32)
    other_sig  = make_sig(@msg_id, @timestamp, @raw_body, other_key)
    valid_sig  = make_sig(@msg_id, @timestamp, @raw_body)
    multi_sig  = "#{other_sig} #{valid_sig}"
    headers    = valid_headers("svix-signature" => multi_sig)

    result = @verifier.verify!(headers, @raw_body)
    assert_equal @body_hash, result
  end

  def test_raises_when_all_signatures_invalid
    other_key  = OpenSSL::Random.random_bytes(32)
    other_sig  = make_sig(@msg_id, @timestamp, @raw_body, other_key)
    third_sig  = "v1,#{Base64.strict_encode64("also_bad_padding_" * 2)}"
    multi_sig  = "#{other_sig} #{third_sig}"
    headers    = valid_headers("svix-signature" => multi_sig)

    assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(headers, @raw_body) }
  end

  # --- Custom tolerance -------------------------------------------------------

  def test_custom_tolerance_accepts_within_window
    verifier   = Xid::WebhookVerifier.new(secret: @secret, tolerance: 600)
    old_ts     = (Time.now.to_i - 400).to_s
    old_sig    = make_sig(@msg_id, old_ts, @raw_body)
    old_headers = { "svix-id" => @msg_id, "svix-timestamp" => old_ts, "svix-signature" => old_sig }

    result = verifier.verify!(old_headers, @raw_body)
    assert_equal @body_hash, result
  end

  # --- message_id_store (svix-id idempotency) ---------------------------------

  def test_message_id_store_rejects_duplicate_svix_id
    seen = {}
    store = ->(msg_id) {
      return false if seen[msg_id]
      seen[msg_id] = true
      true
    }
    verifier = Xid::WebhookVerifier.new(secret: @secret, message_id_store: store)

    verifier.verify!(valid_headers, @raw_body)
    err = assert_raises(Xid::WebhookVerificationError) { verifier.verify!(valid_headers, @raw_body) }
    assert_match(/already been processed/, err.message)
  end

  def test_message_id_store_allows_first_svix_id
    store = ->(_msg_id) { true }
    verifier = Xid::WebhookVerifier.new(secret: @secret, message_id_store: store)
    result = verifier.verify!(valid_headers, @raw_body)
    assert_equal @body_hash, result
  end

  # --- Invalid JSON body ------------------------------------------------------

  def test_raises_on_invalid_json_body
    valid_body = "not json {"
    sig        = make_sig(@msg_id, @timestamp, valid_body)
    headers    = valid_headers("svix-signature" => sig)

    err = assert_raises(Xid::WebhookVerificationError) { @verifier.verify!(headers, valid_body) }
    assert_match(/not valid JSON/, err.message)
  end
end
