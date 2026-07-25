# frozen_string_literal: true

module Xid
  # 请求认证结果。
  # signed_in? 为 true 时 claims 非 nil，反之 reason 描述失败原因。
  class AuthState
    attr_reader :claims, :reason

    def initialize(claims: nil, reason: nil)
      @claims = claims
      @reason = reason
    end

    def signed_in?
      !@claims.nil?
    end

    def self.authenticated(claims)
      new(claims: claims)
    end

    def self.unauthenticated(reason)
      new(reason: reason)
    end
  end
end
