# frozen_string_literal: true

require_relative "test_helper"

class TokenVerifierTest < Minitest::Test
  ISSUER   = "https://xid.dev"
  AUDIENCE = "my_client_id"
  KID      = "test-kid"

  def setup
    @ec_key = OpenSSL::PKey::EC.generate("prime256v1")
    cache    = TestHelpers.mock_jwks_cache(KID => @ec_key)
    @verifier = Xid::TokenVerifier.new(jwks_cache: cache, issuer: ISSUER, audience: AUDIENCE)
  end

  def valid_payload(overrides = {})
    now = Time.now.to_i
    {
      "sub"       => "usr_123",
      "iss"       => ISSUER,
      "aud"       => AUDIENCE,
      "exp"       => now + 3600,
      "iat"       => now,
      "jti"       => "jti_abc",
      "client_id" => "my_client_id"
    }.merge(overrides)
  end

  # --- ES256 happy path -------------------------------------------------------

  def test_verify_valid_es256_token_returns_claims
    token  = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload)
    claims = @verifier.verify!(token)

    assert_instance_of Xid::Claims, claims
    assert_equal "usr_123", claims.sub
    assert_equal ISSUER, claims.iss
    assert_equal [AUDIENCE], claims.aud
  end

  def test_claims_accessors
    token  = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload)
    claims = @verifier.verify!(token)

    assert_equal "usr_123", claims["sub"]
    refute_nil claims.exp
    refute_nil claims.iat
  end

  # --- RSA RS256 happy path ---------------------------------------------------

  def test_verify_valid_rs256_token
    rsa_key  = OpenSSL::PKey::RSA.generate(2048)
    rsa_cache = TestHelpers.mock_jwks_cache("rsa-kid" => rsa_key)
    verifier  = Xid::TokenVerifier.new(jwks_cache: rsa_cache, issuer: ISSUER, audience: AUDIENCE)

    token  = TestHelpers.build_jwt_rs256(rsa_key, payload: valid_payload)
    claims = verifier.verify!(token)
    assert_equal "usr_123", claims.sub
  end

  # --- Algorithm whitelist ----------------------------------------------------

  def test_rejects_alg_none
    token = TestHelpers.build_jwt_with_alg(valid_payload, alg: "none")
    err   = assert_raises(Xid::TokenVerificationError) { @verifier.verify!(token) }
    assert_match(/Unsupported algorithm/, err.message)
  end

  def test_rejects_hs256
    token = TestHelpers.build_jwt_with_alg(valid_payload, alg: "HS256")
    err   = assert_raises(Xid::TokenVerificationError) { @verifier.verify!(token) }
    assert_match(/Unsupported algorithm/, err.message)
  end

  def test_rejects_tampered_signature
    token = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload)
    parts = token.split(".")
    # flip one byte in signature
    bad_sig = parts[2].dup
    bad_sig[0] = bad_sig[0] == "a" ? "b" : "a"
    tampered = [parts[0], parts[1], bad_sig].join(".")
    assert_raises(Xid::TokenVerificationError) { @verifier.verify!(tampered) }
  end

  # --- Claims validation ------------------------------------------------------

  def test_rejects_expired_token
    token = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("exp" => Time.now.to_i - 7200))
    err   = assert_raises(Xid::TokenVerificationError) { @verifier.verify!(token) }
    assert_match(/expired/, err.message)
  end

  def test_rejects_wrong_issuer
    token = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("iss" => "https://evil.example.com"))
    err   = assert_raises(Xid::TokenVerificationError) { @verifier.verify!(token) }
    assert_match(/issuer/, err.message)
  end

  def test_rejects_wrong_audience
    token = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("aud" => "other_client"))
    err   = assert_raises(Xid::TokenVerificationError) { @verifier.verify!(token) }
    assert_match(/audience/, err.message)
  end

  def test_rejects_nbf_in_future
    # nbf = now + 120, leeway = 60 -> should reject
    token = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("nbf" => Time.now.to_i + 120))
    err   = assert_raises(Xid::TokenVerificationError) { @verifier.verify!(token) }
    assert_match(/not yet valid/, err.message)
  end

  def test_accepts_nbf_within_leeway
    # nbf = now + 30, leeway = 60 -> should accept
    token = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("nbf" => Time.now.to_i + 30))
    claims = @verifier.verify!(token)
    assert_equal "usr_123", claims.sub
  end

  # --- JWKS key miss + mock ---------------------------------------------------

  def test_raises_when_no_key_matches_kid
    empty_cache = TestHelpers.mock_jwks_cache({})
    verifier    = Xid::TokenVerifier.new(jwks_cache: empty_cache, issuer: ISSUER)
    token       = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("aud" => nil))
    err         = assert_raises(Xid::TokenVerificationError) { verifier.verify!(token) }
    assert_match(/No matching JWKS key/, err.message)
  end

  # --- Guest (anonymous visitor) -----------------------------------------------

  def test_guest_true_when_amr_contains_guest
    token  = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("amr" => ["guest"]))
    claims = @verifier.verify!(token)

    assert_equal ["guest"], claims.amr
    assert claims.guest?
  end

  def test_guest_false_for_other_amr_values
    token  = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload("amr" => ["pwd"]))
    claims = @verifier.verify!(token)

    refute claims.guest?
  end

  def test_guest_false_when_amr_missing
    token  = TestHelpers.build_jwt_es256(@ec_key, payload: valid_payload)
    claims = @verifier.verify!(token)

    assert_empty claims.amr
    refute claims.guest?
  end

  # --- Malformed token --------------------------------------------------------

  def test_raises_on_malformed_token_two_segments
    # Only 2 segments (missing signature) -> malformed
    assert_raises(Xid::TokenVerificationError) { @verifier.verify!("only.two") }
  end

  def test_raises_on_malformed_token_four_segments
    assert_raises(Xid::TokenVerificationError) { @verifier.verify!("a.b.c.d") }
  end

  def test_raises_on_empty_token
    assert_raises(Xid::TokenVerificationError) { @verifier.verify!("") }
  end
end
