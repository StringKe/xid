# frozen_string_literal: true

module Xid
  SessionTokenHttpResponse = Struct.new(:status, :body, keyword_init: true)

  module SessionTokenExchange
    SESSION_TOKEN_PATH = "/v1/sessions/token"

    module_function

    def exchange(incoming_request_url:, cookie_header:, endpoint: nil, transport: nil)
      resolved = resolve_endpoint(incoming_request_url, endpoint)
      response = if transport
                   transport.call(resolved, cookie_header)
                 else
                   post_without_redirect(resolved, cookie_header)
                 end
      status = Integer(response.status)
      unless status == 200
        raise SessionTokenExchangeError, "Session token exchange returned HTTP #{status}"
      end

      body = JSON.parse(response.body)
      unless body.is_a?(Hash) &&
             body.keys == ["token"] &&
             body["token"].is_a?(String) &&
             !body["token"].strip.empty?
        raise SessionTokenExchangeError, "Session token exchange returned an invalid response"
      end
      body["token"]
    rescue SessionTokenExchangeError
      raise
    rescue JSON::ParserError => e
      raise SessionTokenExchangeError, "Session token exchange returned invalid JSON: #{e.message}"
    rescue StandardError => e
      raise SessionTokenExchangeError, "Session token exchange failed: #{e.message}"
    end

    def resolve_endpoint(incoming_request_url, endpoint)
      incoming = URI.parse(incoming_request_url)
      unless http_uri?(incoming) && incoming.userinfo.nil?
        raise SessionTokenExchangeError,
              "Incoming request URL must be an absolute HTTP(S) URL"
      end
      resolved = URI.join(incoming.to_s, endpoint || SESSION_TOKEN_PATH)
      unless http_uri?(resolved) &&
             resolved.userinfo.nil? &&
             origin(incoming) == origin(resolved) &&
             resolved.path == SESSION_TOKEN_PATH &&
             resolved.query.nil? &&
             resolved.fragment.nil?
        raise SessionTokenExchangeError,
              "Session token endpoint must be exact same-origin #{SESSION_TOKEN_PATH}"
      end
      resolved
    rescue URI::InvalidURIError => e
      raise SessionTokenExchangeError, "Invalid session token exchange URL: #{e.message}"
    end

    def post_without_redirect(uri, cookie_header)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.is_a?(URI::HTTPS)
      http.open_timeout = 10
      http.read_timeout = 10
      request = Net::HTTP::Post.new(uri.request_uri)
      request["Accept"] = "application/json"
      request["Cookie"] = cookie_header
      response = http.request(request)
      SessionTokenHttpResponse.new(status: response.code.to_i, body: response.body.to_s)
    end

    def http_uri?(uri)
      uri.is_a?(URI::HTTP) && uri.absolute? && !uri.host.to_s.empty?
    end

    def origin(uri)
      "#{uri.scheme.downcase}://#{uri.host.downcase}:#{uri.port}"
    end
  end
end
