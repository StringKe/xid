# frozen_string_literal: true

require_relative "lib/xid/version"

Gem::Specification.new do |spec|
  spec.name    = "xid"
  spec.version = Xid::VERSION
  spec.authors = ["XID Contributors"]
  spec.email   = []

  spec.summary     = "XID Identity Platform -- Ruby server-side SDK"
  spec.description = <<~DESC
    服务端 SDK，提供 networkless JWT 验证、请求认证、Webhook 验证。
    Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
  DESC
  spec.homepage    = "https://xid.dev"
  spec.license     = "MIT"
  spec.metadata = {
    "source_code_uri" => "https://github.com/StringKe/xid/tree/main/sdk/ruby",
    "bug_tracker_uri" => "https://github.com/StringKe/xid/issues",
    "rubygems_mfa_required" => "true"
  }

  # Ruby 2.6+ 兼容（系统 Ruby 版本下限）
  spec.required_ruby_version = ">= 2.6.0"

  spec.files = Dir[
    "lib/**/*.rb",
    "xid.gemspec",
    "README.md",
    "LICENSE"
  ]

  spec.require_paths = ["lib"]

  # Ruby 3.4 起 base64 不再作为默认 gem 提供，显式声明以保持 SDK 可用。
  spec.add_dependency "base64", ">= 0.1"

  spec.add_development_dependency "rake", "~> 13.0"
  spec.add_development_dependency "minitest", "~> 5.0"
end
