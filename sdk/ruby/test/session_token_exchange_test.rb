# frozen_string_literal: true

require_relative "test_helper"

class SessionTokenExchangeTest < Minitest::Test
  def setup
    config = Xid::Configuration.new
    config.issuer = "https://app.example"
    @client = Xid::Client.new(config)
  end

  def test_exact_same_origin_success_forwards_complete_cookie
    seen = {}
    transport = lambda do |endpoint, cookie|
      seen[:endpoint] = endpoint.to_s
      seen[:cookie] = cookie
      Xid::SessionTokenHttpResponse.new(status: 200, body: '{"token":"jwt-value"}')
    end
    token = @client.exchange_session_token(
      incoming_request_url: "https://app.example/api",
      cookie_header: "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc",
      transport: transport
    )
    assert_equal "jwt-value", token
    assert_equal "https://app.example/v1/sessions/token", seen[:endpoint]
    assert_equal(
      "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc",
      seen[:cookie]
    )
  end

  def test_cross_origin_rejected_before_transport
    called = false
    error = assert_raises(Xid::SessionTokenExchangeError) do
      @client.exchange_session_token(
        incoming_request_url: "https://app.example/api",
        cookie_header: "__Host-xid.rt.abc=opaque",
        endpoint: "https://xid.dev/v1/sessions/token",
        transport: lambda { |_endpoint, _cookie|
          called = true
          Xid::SessionTokenHttpResponse.new(status: 200, body: '{"token":"jwt"}')
        }
      )
    end
    assert_match(/same-origin/, error.message)
    refute called
  end

  def test_redirect_and_invalid_responses_fail_closed
    responses = [
      Xid::SessionTokenHttpResponse.new(status: 302, body: '{"token":"jwt"}'),
      Xid::SessionTokenHttpResponse.new(status: 200, body: '{"jwt":"wrong"}'),
      Xid::SessionTokenHttpResponse.new(status: 200, body: '{"token":""}'),
      Xid::SessionTokenHttpResponse.new(
        status: 200,
        body: '{"token":"jwt","extra":true}'
      ),
      Xid::SessionTokenHttpResponse.new(status: 200, body: "not-json")
    ]
    responses.each do |response|
      assert_raises(Xid::SessionTokenExchangeError) do
        @client.exchange_session_token(
          incoming_request_url: "https://app.example/api",
          cookie_header: "__Host-xid.rt.abc=opaque",
          transport: ->(_endpoint, _cookie) { response }
        )
      end
    end
  end
end
