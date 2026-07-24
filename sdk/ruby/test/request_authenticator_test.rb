# frozen_string_literal: true

require_relative "test_helper"

class RequestAuthenticatorTest < Minitest::Test
  ISSUER   = "https://xid.dev"
  AUDIENCE = "test_client"
  KID      = "auth-kid"

  def setup
    @ec_key = OpenSSL::PKey::EC.generate("prime256v1")
    cache     = TestHelpers.mock_jwks_cache(KID => @ec_key)
    verifier  = Xid::TokenVerifier.new(jwks_cache: cache, issuer: ISSUER, audience: AUDIENCE)
    @auth     = Xid::RequestAuthenticator.new(token_verifier: verifier)
  end

  def valid_token
    now = Time.now.to_i
    payload = {
      "sub" => "usr_abc",
      "iss" => ISSUER,
      "aud" => AUDIENCE,
      "exp" => now + 3600,
      "iat" => now
    }
    TestHelpers.build_jwt_es256(@ec_key, payload: payload, header_overrides: { "kid" => KID })
  end

  # --- Bearer token in Authorization header -----------------------------------

  def test_signed_in_via_bearer_header
    env   = { "HTTP_AUTHORIZATION" => "Bearer #{valid_token}" }
    state = @auth.authenticate_env(env)

    assert state.signed_in?
    assert_equal "usr_abc", state.claims.sub
  end

  def test_bearer_case_insensitive_prefix
    # RFC 6750: "Bearer" is case-insensitive; our impl uses regex /\ABearer\s+/i
    env   = { "HTTP_AUTHORIZATION" => "BEARER #{valid_token}" }
    state = @auth.authenticate_env(env)

    # Current impl regex uses /i flag
    assert state.signed_in?
  end

  # --- Cookie fallback --------------------------------------------------------

  def test_signed_in_via_cookie
    env   = { "HTTP_COOKIE" => "__xid_token=#{valid_token}" }
    state = @auth.authenticate_env(env)

    assert state.signed_in?
    assert_equal "usr_abc", state.claims.sub
  end

  def test_bearer_takes_precedence_over_cookie
    bad_token = "obviously.bad.token"
    env = {
      "HTTP_AUTHORIZATION" => "Bearer #{valid_token}",
      "HTTP_COOKIE"        => "__xid_token=#{bad_token}"
    }
    state = @auth.authenticate_env(env)
    assert state.signed_in?
  end

  # --- No token ---------------------------------------------------------------

  def test_unauthenticated_when_no_token
    state = @auth.authenticate_env({})

    refute state.signed_in?
    assert_match(/No token found/, state.reason)
  end

  # --- Bad token --------------------------------------------------------------

  def test_unauthenticated_when_token_is_expired
    now  = Time.now.to_i
    payload = { "sub" => "usr_x", "iss" => ISSUER, "aud" => AUDIENCE,
                "exp" => now - 7200, "iat" => now - 7200 }
    expired_token = TestHelpers.build_jwt_es256(@ec_key, payload: payload, header_overrides: { "kid" => KID })
    env = { "HTTP_AUTHORIZATION" => "Bearer #{expired_token}" }

    state = @auth.authenticate_env(env)
    refute state.signed_in?
    refute_nil state.reason
  end

  def test_unauthenticated_when_token_is_garbage
    env   = { "HTTP_AUTHORIZATION" => "Bearer totally.not.a.jwt.at.all" }
    state = @auth.authenticate_env(env)

    refute state.signed_in?
    refute_nil state.reason
  end
end
