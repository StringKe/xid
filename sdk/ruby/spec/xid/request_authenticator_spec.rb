# frozen_string_literal: true

require "spec_helper"

RSpec.describe Xid::RequestAuthenticator do
  let(:claims)   { Xid::Claims.new({ "sub" => "usr_abc", "iss" => "https://xid.dev" }) }
  let(:verifier) { instance_double(Xid::TokenVerifier) }
  let(:auth)     { described_class.new(token_verifier: verifier) }

  describe "#authenticate_env (Rack env)" do
    context "when Authorization: Bearer is present and valid" do
      let(:env) { { "HTTP_AUTHORIZATION" => "Bearer valid_token_here" } }

      before do
        allow(verifier).to receive(:verify!).with("valid_token_here").and_return(claims)
      end

      it "returns signed_in AuthState with claims" do
        state = auth.authenticate_env(env)
        expect(state.signed_in?).to be true
        expect(state.claims.sub).to eq("usr_abc")
      end
    end

    context "when Authorization header is absent" do
      let(:env) { {} }

      it "returns unauthenticated AuthState" do
        state = auth.authenticate_env(env)
        expect(state.signed_in?).to be false
        expect(state.reason).to match(/No token found/i)
      end
    end

    context "when token is present but verification fails" do
      let(:env) { { "HTTP_AUTHORIZATION" => "Bearer bad_token" } }

      before do
        allow(verifier).to receive(:verify!).and_raise(Xid::TokenVerificationError, "expired")
      end

      it "returns unauthenticated AuthState with reason" do
        state = auth.authenticate_env(env)
        expect(state.signed_in?).to be false
        expect(state.reason).to eq("expired")
      end
    end

    context "when token is in cookie" do
      let(:auth) do
        described_class.new(token_verifier: verifier, cookie_name: "__xid_token")
      end
      let(:env) { { "HTTP_COOKIE" => "__xid_token=cookie_token_here" } }

      before do
        allow(verifier).to receive(:verify!).with("cookie_token_here").and_return(claims)
      end

      it "extracts token from cookie and returns signed_in" do
        state = auth.authenticate_env(env)
        expect(state.signed_in?).to be true
      end
    end

    context "when only implicit or Core cookies exist" do
      let(:env) do
        {
          "HTTP_COOKIE" =>
            "__xid_token=app; __session=legacy; __Host-xid.rt.abcdefgh=opaque"
        }
      end

      it "does not locally verify them" do
        expect(verifier).not_to receive(:verify!)
        state = auth.authenticate_env(env)
        expect(state.signed_in?).to be false
      end
    end
  end
end
