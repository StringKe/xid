# frozen_string_literal: true

module Xid
  # 已验证 token 的 claims 封装。
  # 提供便捷访问器，原始 claims hash 通过 #to_h 获取。
  class Claims
    attr_reader :raw

    def initialize(payload)
      @raw = payload.transform_keys(&:to_s).freeze
    end

    # 标准 OIDC claims

    def sub
      @raw["sub"]
    end

    def iss
      @raw["iss"]
    end

    def exp
      @raw["exp"]
    end

    def iat
      @raw["iat"]
    end

    def nbf
      @raw["nbf"]
    end

    def jti
      @raw["jti"]
    end

    # aud 规范允许 String 或 Array<String>
    def aud
      Array(@raw["aud"])
    end

    def scope
      @raw["scope"]
    end

    def client_id
      @raw["client_id"]
    end

    # 任意自定义 claim 访问
    def [](key)
      @raw[key.to_s]
    end

    def to_h
      @raw.dup
    end
  end
end
