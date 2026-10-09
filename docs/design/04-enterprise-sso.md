# 04 - Enterprise SSO Federation and Directory Sync

> Chinese version: [`docs/zh-Hans/design/04-enterprise-sso.md`](../zh-Hans/design/04-enterprise-sso.md)

Benchmarked against WorkOS, whose core product is SSO plus Directory Sync. A tenant's enterprise users
sign in with their own company IdP (Okta, Azure AD, Google Workspace), and XID acts as the SP or RP.

## 1. Upstream SSO federation (XID as SP/RP)

### Capabilities

- SAML 2.0 SP: ACS endpoint, SP EntityID, and SP metadata XML generation and download
- OIDC RP: authorization, token, and userinfo, with PKCE
- SP-initiated: redirect to the IdP authorize endpoint carrying RelayState, then handle the callback
  to exchange the code or assertion
- IdP-initiated: accept an IdP POST to the ACS. The landing page is the RelayState when it resolves to the instance issuer origin, otherwise the connection's `relay_state_url`, otherwise the default post-sign-in page. `relay_state_url` is written through the management API and Console, limited to 2048 characters, resolved against the instance issuer (a relative path becomes an absolute URL), and rejected with 422 unless it is same-origin with the issuer. An authorize or invitation continuation path is never used as a configured landing page, because those continuations must come from server-side flow state
- IdP metadata import: saving a SAML connection with `idp_metadata_url` or an uploaded `idp_metadata_xml` fetches and parses the metadata synchronously, extracting the entityID, SSO URL, SLO URL, and certificates. Sending both fields, an unreachable or non-public-HTTPS URL, a non-2xx response, a body over 1 MiB, unparsable XML, or a parsed SSO/SLO URL that is not public HTTPS returns 422 with `paramName` set to the field that was sent. Fields given explicitly in the same request take precedence over parsed values. Uploading XML clears the stored URL, and submitting a URL clears stored XML; only a URL is refreshed by the daily Cron
- Attribute mapping: `email`, `firstName`, `lastName`, and `groups` name the SAML attribute or OIDC claim to read; an OIDC claim that is configured but absent falls back to the standard claim (`email`, `given_name`, `family_name`, `groups`). SAML `idpId` names the attribute used as the stable primary key (see the decisions below)
- Certificate management: when the tenant has an active `saml_sp_signing` certificate, every SP-initiated AuthnRequest carries an HTTP-Redirect binding detached signature over `SAMLRequest`, `RelayState`, and `SigAlg`, and the SP metadata advertises `AuthnRequestsSigned` from the same certificate check; the IdP assertion signature MUST be verified; old and new certificates coexist during rotation; EncryptedAssertion is decrypted
- Console endpoints: a SAML connection shows the absolute SP entity ID, ACS URL, SP metadata URL,
  and SLO URL derived from the instance issuer. An OIDC connection shows one callback URL per origin
  a user can start sign-in from (instance issuer, tenant host, Hosted Auth origin), because the
  callback follows the sign-in origin; the admin registers all of them at the IdP. The outbound SAML
  app page (section 2) shows the absolute IdP entity ID, metadata, SSO, and SLO URLs; a preset's
  downstream OIDC redirect URI is read-only reference text and is not stored

### Design decisions

- Each org has exactly one SSO connection. A connection maps 1:1 to an org and is never reused across
  tenants
- The primary key is the idp_id. Matching on email alone is forbidden, because an email change would orphan the account. For OIDC the idp_id is always `sub`. For SAML and WS-Federation it is the NameID, unless `attribute_mapping.idpId` names an attribute (for example the Entra object identifier, because the default Entra NameID is the UPN and changes when the UPN changes); a configured attribute that is missing or empty in the assertion rejects the sign-in with 400 `malformed_request` and never falls back to the NameID. When a connection switches to an `idpId` attribute, an identity still bound under the assertion's NameID is matched as the legacy binding: JIT signs in that User and binds the new idp_id, so existing accounts are not duplicated
- Saving a connection rejects `{` or `}` in `idp_entity_id`, `idp_sso_url`, `idp_slo_url`, `idp_metadata_url`, and `oidc_discovery_url` with 422, so a preset template value cannot be stored. `attribute_mapping` keys starting with `_` are server-owned; a client may submit only `_legacy`
- RelayState is capped at 2 KB; anything longer is truncated and logged
- OIDC RP connections accept a write-only `oidc_client_secret` on both `/v1/connections` and
  `/v1/organizations/:orgId/sso-connections`. It is KEK-envelope-encrypted into
  `oidc_client_secret_ciphertext`; reads return only `oidc_client_secret_configured`. Omitting the
  field keeps the stored secret, `null` clears it. The code exchange always sends the PKCE
  `code_verifier`; with a secret it uses `client_secret_basic` (form-urlencoded per RFC 6749 2.3.1)
  unless discovery lists `client_secret_post` without `client_secret_basic`. Without a secret the
  connection is a PKCE public client
- SP-initiated `/sso/oidc/*` and `/sso/saml/*/login` are browser navigations: expected failures and
  an IdP `access_denied` redirect to the Hosted UI `/sign-in?error=<code>` (see chapter 01,
  "Browser-facing errors"). The ACS keeps its HTML protocol error page
- The daily Cron (`0 2 * * *`) refreshes every active SAML connection that has `idp_metadata_url`. It rewrites the entity ID, SSO URL, SLO URL, and certificate set only when one of them changed. Certificates are merged, not replaced: every certificate in the metadata is used, and a stored certificate that disappeared from the metadata stays until its own notAfter, so Assertions the IdP still signs with the old certificate during a rotation keep verifying; unparseable or expired stored certificates are dropped. Only a newly added certificate emits the `connection.saml_certificate_renewed` webhook. Each run records the outcome on the connection: success sets `idp_metadata_refreshed_at` and clears the error columns; failure keeps the previous configuration, logs the reason, and sets `idp_metadata_last_error` (`metadata_url_not_allowed`, `metadata_http_status`, `metadata_too_large`, `metadata_invalid`, `metadata_endpoint_not_allowed`, or `metadata_fetch_failed`) and `idp_metadata_last_error_at`, which the Console connection detail shows. Every Cron statement binds `tenant_id`
- OIDC discovery trust: the configured discovery URL MUST have the same origin as the discovered `issuer`, the issuer MUST be public HTTPS without userinfo, query, or fragment, and the ID token `iss` MUST equal it exactly. The `authorization_endpoint`, `token_endpoint`, and `jwks_uri` only need to be public HTTPS without userinfo and may live on other hosts (Google serves token and JWKS from `googleapis.com`), as OIDC Discovery 1.0 section 4.3 allows
- Upstream OIDC JWKS are cached in KV under `provider_jwks:{jwks_uri}` for `SSO_OIDC_JWKS_CACHE_TTL_SEC` (3600 seconds), the same key family as social login. A signature with an unknown `kid` forces one refetch and re-verification; refetches of one `jwks_uri` are limited to one per `PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC` (300 seconds), and every origin fetch, including a cold-cache fetch, counts toward that interval
- Upstream ID token validation (OIDC Core 3.1.3.7): `exp` and `iat` MUST be present numbers; when `aud` has more than one value `azp` MUST be present; a present `azp` MUST equal the connection's client ID; `nonce` MUST match the flow; `sub` MUST be present. `email_verified` vouches only for the standard `email` claim, so an email read from a different mapped claim is not treated as verified
- Every configured IdP SSO, SLO, metadata, and OIDC discovery URL MUST be public HTTPS. The management
  write paths validate it, and the SAML/OIDC runtime validates stored rows again so a legacy or
  directly imported record cannot bypass the boundary. Metadata fetches reject redirects, use a
  bounded response, and enforce a timeout; SSO and optional SLO URLs parsed from metadata are
  validated before they are persisted. Inbound SLO uses only the configured or metadata-derived
  `SingleLogoutService`; it never guesses an endpoint from the SSO URL or EntityID

### Data model

The core entities are SsoConnection (a per-org IdP connection: SAML/OIDC configuration, certificates,
attribute mapping, domain hints) and SsoProfile (the result of a single authentication) -- see
chapter 08.

Console: `/console/org/sso` shows a first-run page while the Organization has no connection and the
connection detail once it has one; `?step=new` opens the three-step creation wizard (choose the IdP,
exchange metadata, review domain routing). The detail lists the parsed IdP certificates with their
expiry, the routed domains as read-only routing state (section 5), the last sign-in, and the
connection's audit activity. A new IdP certificate is added beside the old one so both stay trusted
until the old one expires.

### 1.1 Current status

| Direction       | XID role              | External counterpart                                                                                                | Status              | L4 boundary                                                |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------- |
| Inbound SAML    | SAML SP               | Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth, Keycloak | provider-ready      | Missing real IdP metadata, config, and callback L4         |
| Inbound OIDC    | OIDC RP               | The same OIDC-capable IdPs                                                                                          | provider-ready      | Missing real IdP discovery, client config, and callback L4 |
| Inbound SCIM    | SCIM Service Provider | An external IdP or directory                                                                                        | implemented         | Missing real provisioning into XID L4                      |
| Downstream SAML | SAML IdP              | Slack, GitHub Enterprise Cloud, Microsoft custom app, Atlassian, Salesforce, Zoom                                   | local-mock verified | Missing real SaaS admin L4                                 |
| Downstream OIDC | OIDC IdP              | Microsoft custom app, Salesforce, Zoom, and other OIDC-capable SaaS                                                 | provider-ready      | Missing automated SaaS OIDC registration and real SaaS L4  |
| Outbound SCIM   | SCIM client           | Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, Zoom                                                         | local-mock verified | Missing real SaaS SCIM target L4                           |

## 2. Downstream SaaS SSO (XID as the IdP)

Scenario: an enterprise customer configures XID as the identity provider for downstream SaaS
applications such as Slack, GitHub Enterprise Cloud, a Microsoft Entra custom enterprise app,
Atlassian, Salesforce, or Zoom. This role is the inverse of section 1: section 1 is XID acting as an
SP/RP against an upstream enterprise IdP, while this section is XID acting as a SAML IdP or OIDC IdP
issuing assertions or tokens to downstream SaaS.

Current status: the outbound SAML IdP has shipped (local L1-L3). Public documentation does not promise
that Slack, GitHub Enterprise, a Microsoft custom app, Atlassian, Salesforce, or Zoom are
production-supported. The `saml_service_providers` schema is already in use as the downstream SP
registry. The first six SaaS preset forms and the per-app user/role assignment gate are implemented
in Console. Real SaaS L4 evidence, automated provider configuration, and a complete app catalog are
still missing.

Capabilities already shipped in the SAML IdP baseline:

- IdP metadata XML: entityID, SSO URL, signing certificate, and NameIDFormat.
- IdP signing certificates: one tenant-level set in `cert_store` with usage `saml_idp_signing`, shared by every outbound SAML app of the tenant, with the private key envelope-encrypted under the Workers Secret KEK. Status moves `next` -> `active` -> `retiring` -> `retired`; partial unique indexes allow one `active` and one `next` per tenant and never touch SP signing or encryption certificates. Validity is read from the X.509 certificate rather than nullable database bounds. Creating an app without `idp_signing_cert_id` uses the current `active` certificate and generates the first one only when the tenant has none; an explicit `idp_signing_cert_id` MUST be a time-valid `active` or `retiring` certificate of the tenant (422 otherwise); an expired `active` certificate returns 503 and is never replaced automatically.
- Certificate rotation, modeled on the four-step signing key rotation: the daily Cron publishes a `next` certificate once the `active` one expires within 60 days (audit `outbound_saml_signing_certificate.next_published`), writes the `outbound_saml_signing_certificate.expiring` audit event every day once it expires within 30 days, and moves `retiring` to `retired` after `retire_after` or the certificate's notAfter. IdP metadata publishes the `next`, `active`, and `retiring` certificates together so SPs can trust the new key before it signs; signing uses `active` and `retiring`. Promotion is an explicit administrative action, never a background job: `POST /v1/organizations/:id/outbound-saml-signing-certificates/:certificateId/activate` in one D1 batch moves the old `active` to `retiring` with `retire_after` = the earlier of now + 7 days and its notAfter, promotes the `next` certificate, and points every outbound app of the tenant at it (audit `outbound_saml_signing_certificate.activated`). `GET` on the collection lists the certificates and `POST` prepares a `next` certificate on demand; preparing and activating require an `sk_*` key with `connections:write` or a manager of the tenant's top-level Organization.
- SP registration: each downstream SaaS gets its own record of the ACS URL, SP EntityID, Audience, Recipient, attribute mapping, and NameID policy. ACS and optional SLO URLs MUST be public HTTPS at registration and are revalidated before assertion delivery or logout. `{` or `}` in the SP entity ID or ACS URL, and client-submitted `_`-prefixed `attribute_mapping` keys, are rejected with 422. `name_id_format` is limited to the formats listed under NameID below.
- SP metadata import: create and update accept `sp_metadata_url` (public HTTPS, no redirects, 1 MiB limit, timeout) or `sp_metadata_xml`, not both. The parser reads the entityID, the HTTP-POST AssertionConsumerService (`isDefault="true"` first, otherwise the lowest index), the SingleLogoutService, and the signing certificates; a missing entityID or POST ACS, a non-public-HTTPS endpoint, or `AuthnRequestsSigned="true"` without a signing certificate returns 422 with the field's `paramName`. The Console create and edit forms accept a metadata URL or pasted XML and show these errors on the field.
- SSO endpoint: accepts an SP-initiated SAMLRequest or an IdP-initiated app launch, and verifies the user session. Before any assertion is issued the user MUST be an active member of the app's Organization or hold an `org_manager` assignment for it; in `restricted` assignment mode only active members pass, and the allowed user IDs and roles are intersected with that membership. SP-initiated requests pass the same secure XML precheck and a dedicated closed AuthnRequest grammar before exact Issuer, Destination, HTTP-POST binding, and ACS matching against the registered SP. The grammar follows SAML Core 3.4.1: after `Issuer` and an optional `ds:Signature` it accepts, in order, `Extensions` (children in a non-SAML namespace), `NameIDPolicy`, `saml:Conditions`, `RequestedAuthnContext` (`Comparison` of `exact`, `minimum`, `maximum`, or `better`), and `Scoping`; `Subject` is rejected. Root attributes may include `Consent`, `ForceAuthn`, `IsPassive`, `ProtocolBinding`, `AssertionConsumerServiceIndex`, `AssertionConsumerServiceURL`, `AttributeConsumingServiceIndex`, and `ProviderName`; an ACS index excludes the ACS URL and protocol binding. A missing `AssertionConsumerServiceURL` or `ProtocolBinding` falls back to the registered ACS and HTTP-POST. `RequestedAuthnContext` is parsed and returned by the verifier but not evaluated; issued assertions carry the `unspecified` authentication context class. Metadata currently advertises
  `WantAuthnRequestsSigned=false`; unsigned requests are therefore accepted, while any embedded
  XMLDSig or Redirect `Signature`/`SigAlg` that is present must verify against the SP certificates.
  When the browser has no active session, the request is verified first and its `InResponseTo` and
  RelayState are staged in the OAuth flow Durable Object; the user is sent to `/sign-in` (or to
  `/mfa` or MFA setup for a pending MFA session) with a `saml_request` resume handle, so HTTP-POST
  and HTTP-Redirect requests both survive sign-in. The handle is single use.
- Assertion issuance: signs the Response and the Assertion, and sets Issuer, Subject, NameID, AudienceRestriction, Recipient, Destination, NotOnOrAfter, email, and name. Every XML signature XID emits canonicalizes `SignedInfo` and the Reference with exclusive C14N (see 9.5).
- ForceAuthn and IsPassive (SAML Core 3.4.1): with `ForceAuthn="true"` only an authentication completed at or after the AuthnRequest arrived counts, so an older session is sent through re-authentication and the request resumes afterwards. With `IsPassive="true"` and no qualifying session, XID returns a `Responder` / `NoPassive` status Response instead of showing any sign-in page.
- NameID: supported formats are `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`, `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`, `urn:oasis:names:tc:SAML:2.0:nameid-format:transient`, and `urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified`, plus the SAML 2.0 namespace spellings of emailAddress and unspecified stored by older configurations. A `NameIDPolicy` naming a supported format overrides the app's configured format; an absent or `unspecified` policy uses the configured format. Values follow SAML Core 8.3: emailAddress is the primary email; unspecified is the email, else the username; persistent is a pairwise pseudonym, 32 random bytes in base64url generated on first issuance for (tenant, app, user), stored in `saml_persistent_name_ids` (concurrent first issuance converges through `INSERT ... ON CONFLICT DO NOTHING`), reused afterwards, deleted with the app or by user erasure, and included in the privacy export; transient is a new random value per assertion. An unsupported requested format returns a `Requester` / `InvalidNameIDPolicy` status Response; an unsupported configured format or a user without the value the format needs returns `Responder` / `InvalidNameIDPolicy`.
- Error status Responses (SAML Core 3.2.2.2): `NoPassive` and `InvalidNameIDPolicy` are returned as a Response without an assertion, carrying the request's `InResponseTo` and RelayState, signed with the same IdP signing certificate as a Success Response, and POSTed to the registered ACS.
- Attribute mapping: the app's `attribute_mapping` renames the emitted `email`, `userEmail` (default `User.Email`), `firstName`, `lastName`, and `displayName` attributes. The `userId` key emits the XID user ID under the configured attribute name and is omitted unless configured; the Atlassian preset uses it for an immutable user ID.
- Verification: package-level XML signature tests, Worker route L2, and a fake SaaS SP at L3 are all
  covered. Real Slack, GitHub, Microsoft, Atlassian, Salesforce, and Zoom admin L4 evidence is still
  missing.
- Preset and assignment UI: Console provides Slack, GitHub Enterprise Cloud, Microsoft custom app,
  Atlassian, Salesforce, and Zoom presets, plus `all` or restricted user/role assignment gates.
- App detail: `/console/org/outbound-sso?appId=` shows the tenant's `next`, `active`, and `retiring` IdP signing certificates, where a top-level Organization manager can prepare the next certificate and activate it after a confirmation, plus the last sign-in (from SAML session bindings, so it is empty once expired bindings are cleaned up) and the app's audit activity.
- Outbound SLO is browser-mediated. `/auth/sign-out` prepares the first signed HTTP-Redirect or
  HTTP-POST LogoutRequest action, revokes the local XID session before returning, and never performs
  a server-side fetch to an SP. The Core and Web UI SDKs execute that action in the user agent. A
  missing or invalid stored SP endpoint is audited and skipped while selecting the first usable
  action, so it cannot block local sign-out.
- Every emitted LogoutRequest stores a one-time `ChallengeStore` context bound to the tenant, app,
  request ID, SessionIndex, exact RelayState, same-origin return URL, and remaining SP targets. The
  `/sso/outbound/saml/:appId/slo` callback requires a signed matching LogoutResponse from the
  registered SP, consumes the context by `InResponseTo`, and rejects replay or RelayState mismatch.
  A Success response revokes the mapped SAML session binding. A signed non-Success response is
  audited without revoking that binding, but still advances to the next browser action so one SP
  cannot block local logout from the others. When the chain is empty it redirects only to the
  issuer-origin `/sign-in`.

Capabilities still missing:

- Automated provider-side setup and validation against real Slack, GitHub Enterprise Cloud,
  Microsoft, Atlassian, Salesforce, and Zoom admin environments.
- Directory-group assignment beyond the implemented explicit user-id and membership-role gate.
- Groups/roles claim mapping: mapping XID membership or directory groups to the attribute each SaaS
  expects.

Unsupported boundary: SAML Single Logout MUST NOT currently be claimed as production-supported for
Slack. Slack's official custom SAML documentation states that Slack does not support Single Logout,
so the outbound SAML IdP MUST NOT claim SLO is production-supported for Slack. Inbound and outbound
SAML SLO for generic SPs is implemented (signature verification, SessionIndex mapping, and
LogoutResponse), but real IdP/SaaS SLO callback L4 evidence is still missing.

## 3. Downstream SaaS SCIM target clients

Scenario: an enterprise customer wants XID to push users and groups to the SCIM API of downstream SaaS
applications such as Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, or Zoom. This role is the
inverse of section 6: section 6 is XID acting as a SCIM Service Provider accepting pushes from an
external IdP, while this section is XID acting as an outbound SCIM client pushing users and groups to
a SaaS target.

Current status: the downstream SaaS SCIM target client has shipped (local L1-L3). Public documentation
does not promise production-supported SCIM push-to-SaaS for Slack, GitHub Enterprise, Atlassian,
Salesforce, or Zoom. Inbound SCIM Service Provider evidence, local inbound SCIM CRUD L3, and real IdP
provisioning L4 MUST NOT be reused as outbound SCIM target L4.

Capabilities already shipped in the outbound SCIM client baseline:

- Target registration: each downstream SaaS gets its own record of the SCIM base URL, encrypted
  bearer token, attribute mapping, group mapping, and assignment gate. The base URL MUST be public
  HTTPS.
- Token storage: an org admin or an `sk_*` key submits the SaaS SCIM bearer token as the write-only
  `token` field on create or update. It is envelope-encrypted under the Workers Secrets KEK
  (AES-256-GCM, the same `iv`/`ciphertext`/`tag` layout as webhook signing secrets) and stored in
  `scim_targets`; responses only report `hasToken`, and the plaintext is decrypted only inside the
  queue consumer. A target created before encrypted storage keeps its token in the Workers Secret
  `SCIM_TARGET_TOKEN_<target id>` (`-` replaced by `_`); Core uses that secret only while the
  encrypted columns are empty, and derives its name from the target id, never from a stored value.
  A target without either token cannot be synced (`422`, `paramName = token`). Because
  the token is sent as a bearer to the base URL, an update that moves the base URL to a different
  origin MUST resubmit `token` (`422`, `paramName = token` otherwise). Logs and
  audit records MUST redact the token.
- Sync endpoints: `/scim/outbound/:targetId/sync` and
  `/v1/organizations/:orgId/scim-targets/:targetId/sync` authorize the caller, enqueue one
  `ScimSyncQueueMessage`, and return `202` with the stable `runId`; downstream HTTP never runs in the
  request path.
- Incremental runs: changing a member's role, removing, deactivating, or restoring an Organization Membership through the membership APIs, a member leaving an Organization, deleting, restoring, banning, or unbanning a user through `/v1/users`, and inbound SCIM deactivation, reactivation, or deletion of a user enqueue a single-user message (`userId` set) for every token-configured active target of the affected Organizations (for account-level changes, every Organization the user belongs to), off the request path through `waitUntil`. The consumer pushes only that user and refreshes the role Groups from the local mappings.
- Full reconciliation: the daily cron and the manual sync endpoints enqueue a full run per target. A full run processes active members in chunks of 98 ordered by member ID; when members remain, the consumer enqueues the next chunk with a `cursor` under the same `runId` and then acks, so a retry repeats only the current chunk. Group reconciliation and stale-mapping deprovision run only after the last chunk. An Organization-level full enqueue keeps at most one not-yet-started run per target: `scim_targets.full_sync_queued_at` claims the slot, the consumer clears it when the run starts, and a claim older than `SCIM_FULL_SYNC_DEDUPE_WINDOW_MS` (one hour) is replaced. Duplicate runs are safe because the consumer is serialized and idempotent.
- Run visibility: the consumer records `last_run_status` (`succeeded` / `retrying` / `failed`),
  `last_run_error` (a reason code with an optional downstream HTTP status, never a response body or
  token), and `last_run_at` on the target; the Console shows them next to the last successful sync.
- Stable resource mapping: `scim_target_resources` binds each local User or role-derived Group to the
  downstream SCIM `id`. A retry first uses that mapping; when it is absent or stale, the consumer
  discovers by the deterministic `externalId` before creating anything. `POST` is therefore only the
  last step after a zero-result discovery, while mapped resources use `PUT`.
- Group payloads reference downstream User ids from the same target's mappings, never XID User ids.
- Safe deprovision: only after every chunk of a full run has upserted every currently eligible User and Group successfully may the consumer process mappings absent from the current Organization Membership plus assignment-gate intersection. Stale Users receive `PATCH active=false`; stale role Groups are replaced with an
  empty member set and retain their mapping for later reactivation. A partial run never deprovisions.
- Retry and audit: network failures, `408`, `429`, and `5xx` retry through `SCIM_QUEUE`. `429` honors
  either `Retry-After` delta-seconds or HTTP-date, clamped to the Queue delay range; other retries use
  bounded exponential backoff. Accepted, retry-scheduled, succeeded, and terminal-failed transitions
  carry the same `runId` through the append-only `AUDIT_QUEUE`; response bodies and bearer tokens are
  never copied into audit payloads.
- Verification: a fake SaaS SCIM at L3 covers discovery/create, mapped update, idempotent retry,
  downstream-id Group members, deprovision, and `Retry-After` Queue behavior. Real Slack, GitHub
  Enterprise, Atlassian, Salesforce, and Zoom admin L4 evidence is still missing.

The SCIM consumer runs with `max_batch_size = 1` and `max_concurrency = 1`. This intentionally
serializes target runs so two accepted requests cannot both observe an absent mapping and create the
same downstream resource. Queue delivery is still at-least-once, so this serialization is not the
idempotency mechanism by itself; deterministic `externalId` discovery plus the persisted mapping is.
The mapping closes correctness for runs after this schema is deployed. It does not infer or mutate
unknown historical SaaS accounts created before the mapping existed; production history cleanup is a
separate, explicit reconciliation operation.

Capabilities still missing:

- SaaS template UI: the first batch of SCIM target templates for Slack, GitHub Enterprise Cloud,
  Atlassian, Salesforce, and Zoom.
- A fine-grained assignment gate and an attribute/group mapping UI.
- Provider-specific bulk cursors and real-SaaS conflict/429 behavior validated at L4.

## 4. JIT provisioning

- SAML, OIDC, and legacy protocols share one implementation, `jitProvision` in
  `apps/server/worker/sso/jit.ts`
- The first SSO sign-in creates the User automatically. The User, primary Email, identity, and
  managed Membership are written in one D1 batch, so a failure leaves no orphan rows
- Attribute sync: every sign-in overwrites first_name, last_name, and custom_attributes with the
  non-null values of the latest assertion; a missing attribute does not clear the stored value
- Role mapping: the connection's `role_mapping` maps an IdP group to an Organization role (`member`, `admin`, `owner`); the first matching group wins. A new membership gets the mapped role, or `member` when nothing matches. An existing membership is only promoted (member < admin < owner) and never demoted: no match, or a match ranked lower than the current role, keeps the current role, so an IdP group change cannot strip an owner or admin of Organization management
- Conflict handling: exact idp_id match (then the legacy NameID binding described in section 1) > email association > create new
- Email association rule (`apps/server/worker/sso/account-link.ts`, shared by SAML, OIDC, and legacy JIT and by inbound SCIM): the local Email MUST be verified and the IdP Email MUST be trusted. The IdP Email is trusted when the IdP asserts `email_verified: true` (OIDC; inbound SCIM is a trusted directory and counts as asserted) or the Email domain is a verified, active `organization_domains` row of the connection's Organization (wildcard rows cover subdomains at any depth, with the same rule as HRD in section 5; SAML has no `email_verified` and relies on the domain). A trusted Email then links the existing User when one of two conditions holds:
  - the User is already an active member of the connection's Organization
  - the IdP asserts `email_verified: true` and the Email domain is verified for that Organization;
    the Organization vouches for every address in that domain, so membership is not required
- An existing Email that fails the rule is rejected with `invalid_credentials`; JIT never logs in,
  links, or creates a second account for that Email, because `UNIQUE (tenant_id, email)` allows only
  one owner
- A new User's Email is stored as verified only when the IdP Email is trusted: the IdP asserts
  `email_verified: true` or the domain is verified for the Organization
- A revoked identity for the same `(connection, idp_id)` is rebound to the matched User instead of
  inserting a duplicate row (see chapter 01, identity rows)
- JIT can be toggled per connection (some enterprises require SCIM-only control and forbid automatic
  JIT account creation); a disabled connection with no existing User returns `provisioning_disabled`
  (403)

Users created by JIT are tagged `provisioned_by: jit_sso`. Constraint: JIT only handles onboarding and
attribute updates; it cannot deprovision, so it MUST be paired with SCIM.

## 5. Domain-based routing / HRD

- Route by email domain to the corresponding org's SSO connection
- Domain verification: DNS TXT (`xid-verify=<token>`) or an HTTPS file
- A domain can be claimed by exactly one org, and wildcard subdomains are supported. A wildcard row covers its subdomains at any depth: HRD first looks for an exact verified, active, non-deleted domain row, then checks each parent domain from the nearest outward (keeping at least two labels) for such a row marked wildcard. JIT trusted-email checks use the same coverage rule
- After the user enters an email on the sign-in page: look up the domain -> find the active connection
  -> redirect to the IdP
- Multiple domains per org; unverified domains do not trigger SSO routing
- When no connection matches, `/sso/hrd` returns `connectionId: null` and the Hosted UI tells the
  user that the Email domain does not use enterprise SSO and to choose another sign-in method
- During an invitation flow `/sso/hrd` returns `connectionId: null` without discovery; invitations
  are accepted only through the Email claim (chapter 01)

Data model: the core entity is OrganizationDomain (see chapter 08), which carries the domain
verification status and method.

The daily Cron (`0 2 * * *`) checks every pending domain, and an Organization manager can run the
same DNS-over-HTTPS check on demand (`POST /v1/organizations/:orgId/domains/:domainId/verify`). Both
record `last_checked_at` and `last_check_result` (`found` / `not_found`). A verified domain is a
precondition for JIT SSO. Routing has no per-domain switch: every verified domain of the Organization
routes to its connection.

## 6. SCIM 2.0 (Directory Sync)

### Capabilities

- Act as a SCIM 2.0 server accepting pushes from Okta, Azure AD, and Google Workspace
- Endpoint prefix: `/scim/v2/organizations/{organization_id}/`, where `organization_id` is the
  top-level Organization (tenant) id, also for directories that belong to a child org. The SCIM base
  URL is `{issuer}/scim/v2/organizations/{tenant_id}`: on the instance root domain the tenant is
  resolved from that path id, so one base URL works for every tenant in multi-tenant mode; tenant
  subdomains and custom hostnames keep Host-based resolution. An unknown organization id returns the
  same 401 as a wrong token
- Standard endpoints: Users, Groups (GET/POST/PUT/PATCH/DELETE), ServiceProviderConfig, Schemas, and
  ResourceTypes
- Bearer token authentication: a per-directory token supporting rotation (with a 30-minute grace
  period for the old token)
- Console: the directory page shows the SCIM base URL and the token with copy actions, the grace
  deadline of the previous token after a rotation, and deletes a directory. Deleting a directory
  invalidates its current and previous tokens immediately; users it provisioned keep their accounts
- User provisioning: create, update, deactivate (`active=false`), reactivate, and delete, applied to the bound XID User. `active` accepts a JSON boolean or the case-insensitive strings `"true"` and `"false"` (Microsoft Entra without the `aadOptscim062020` flag deactivates with `"False"`); an omitted value means active, and any other value returns 400 `invalidValue`. POST, PUT, and PATCH share this rule, so a string `"False"` runs the full deprovisioning sequence in 10.1.2
- `password` is writeOnly and returned=never (RFC 7643 4.1): it is removed before the request body is stored in `scim_raw`, including when nested under the core User schema URN key, on POST, PUT, and the merged PATCH result. Migration `0023_scim_secret_hotfix` removed previously stored top-level `password` keys
- Group provisioning: create, update, delete, with incremental member PATCH, including removal through `members[value eq "<id>"]` paths. Group PUT replaces the whole member set, pending members included
- Webhooks: directory events pushed to the application endpoint
- Attribute mapping: `emails[primary]` (or `userName` when it is an email) becomes the XID User's
  verified primary email when the User is created, and `name.givenName` / `name.familyName` update
  first and last name. A `userName` that is not an email becomes the XID `username`. `department`,
  `title`, and the remaining attributes stay on the DirectoryUser record (`scim_raw`)
- Not implemented: Group-to-role mapping. Directory Groups and their members are stored and returned
  over SCIM, but group membership never changes an org role. Directory-provisioned memberships are
  created with the `member` role; org admins change roles through the membership APIs

### Design decisions

- SCIM User and XID User are bound through `directory_users.user_id`. An active SCIM User is bound
  when it is created or first becomes active: an existing XID User is linked only under the email
  association rule in section 4, otherwise a new XID User is created with `provisioned_by = scim`.
  When the email already belongs to an account that fails the rule, the request returns 409
  `uniqueness` and nothing is written. Binding also ensures an `is_managed` membership in the
  directory's org; a membership the org manages by hand is never rewritten by the directory
- Deprovisioning (`active=false`) runs the sequence in 10.1.2 and does not delete the XID User (which
  preserves the audit trail). Reactivation (`active=true`) restores only a User whose status is
  `deactivated`; `banned` or other administrator states are never lifted by the IdP.
  `DELETE /Users/{id}` runs the same sequence, sets the managed membership to `inactive`, maps to a
  directory user soft delete, and never physically deletes the XID User
- Rehire: when POST creates an active User whose `externalId` (or, without one, case-insensitive `userName`) matches a deleted DirectoryUser of the same directory that was bound to an XID User, that XID User is reused instead of being judged against the email association rule, because its managed membership was suspended by the earlier delete
- Uniqueness within a directory is judged only among resources that are not deleted: `userName` (case-insensitive), `externalId` (case-exact), and Group `displayName` (case-insensitive). POST, PUT, and PATCH return 409 `uniqueness` on a conflict, and a concurrent write that reaches the partial unique indexes from migration `0024_scim_live_uniqueness` is mapped to the same 409. A PATCH that changes `externalId` also updates the `external_id` column used by responses and `externalId` filters
- OneLogin quirk: a PATCH of group members can arrive before the user is created, so the server MUST
  handle an unknown member idempotently

### Data model

The core entities are Directory, DirectoryUser, and DirectoryGroup (see chapter 08): the directory
connection and the synced users and groups.

## 7. Supported enterprise IdPs

| IdP                  | SAML | OIDC | SCIM | Notes                                                             |
| -------------------- | ---- | ---- | ---- | ----------------------------------------------------------------- |
| Okta                 | Y    | Y    | Y    | The most mature; PATCH follows the standard                       |
| Microsoft Entra ID   | Y    | Y    | Y    | Groups flow through SCIM; the OIDC groups claim must be enabled   |
| Google Workspace     | Y    | Y    | Y    | OIDC is the primary path                                          |
| OneLogin             | Y    | Y    | Y    | SCIM Groups PATCH has ordering issues, so idempotency is required |
| PingFederate/PingOne | Y    | Y    | Y    | Mostly on-premises; metadata handling is fiddly                   |
| JumpCloud            | Y    | Y    | Y    | SAML attribute naming differs from Okta                           |
| Generic SAML 2.0     | Y    | -    | -    | Fallback                                                          |
| Generic OIDC         | -    | Y    | -    | Fallback                                                          |

The first five get a detailed per-provider wizard; the last two are the generic fallback.

## 7.1 Enterprise legacy protocols (local baseline)

The enterprise legacy protocols have a shipped local baseline (L1-L3) covering LDAP direct bind,
WS-Federation passive sign-in, SWA/password vaulting, header-based SSO, and the directory connector
framework. Public documentation does not promise that real AD/LDAP, AD FS, or Okta SWA are
production-supported; real IdP, LDAP gateway, Kerberos KDC, and Application Proxy L4 evidence is still
missing.

| Protocol                      | XID route                                                                                      | Local evidence                   | L4 boundary                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| LDAP direct bind              | `POST /sso/ldap/:connectionId/login`                                                           | fake LDAP harness L3             | Needs a real LDAP/AD HTTP gateway or a sidecar bind                            |
| WS-Federation                 | `GET /sso/wsfed/:connectionId/login`, `POST /sso/wsfed/:connectionId/callback`                 | fake WS-Fed harness L3           | Needs real AD FS/Entra WS-Fed metadata and a signed wresult                    |
| SWA / password vaulting       | `/sso/swa/apps`, `/sso/swa/:connectionId/vault`, `/sso/swa/:connectionId/launch`               | route tests L2                   | Needs a real target app login form and vault rotation L4                       |
| Header-based SSO              | `POST /sso/header/:connectionId/authenticate`                                                  | route tests L2                   | Needs a trusted reverse proxy / Application Proxy and real header injection L4 |
| Directory connector framework | `GET /sso/directory-connectors/types`, `POST /sso/directory-connectors/:connectionId/validate` | connector registry + validate L2 | SQL/REST/SOAP/PowerShell/ECMA connectors are still stubs                       |

Connection configuration still uses `sso_connections`, where `protocol` takes the values `ldap`, `wsfed`, `swa`, or `header`, and the protocol-specific detail lives in `attributeMapping._legacy`. Secret material is write-only: management responses drop it from `legacy_config` and report only `trusted_proxy_secret_configured` and `ldap_gateway_secret_configured`. Every query still goes through the tenant query layer, a connection maps 1:1 to an org, and cross-tenant reuse is forbidden.

LDAP direct bind: each connection authenticates to its own HTTP gateway (`_legacy.ldapGatewayUrl`) with its own bearer secret, `_legacy.ldapGatewaySecret`, submitted once (32 to 1024 characters) and stored only as a KEK envelope in `attributeMapping._ldapGatewaySecretEnvelope`. There is no instance-level gateway secret. A stored secret stays bound to the gateway URL it was submitted for, so changing the URL requires resubmitting the secret (422 otherwise). The gateway URL MUST be public HTTPS without `{` or `}` and without a documentation-reserved host (`example.com`, `example.net`, `example.org`, or the `.example`, `.test`, `.invalid`, `.localhost` TLDs); the same rule applies to the SWA target URL, because both endpoints receive user passwords.

Header-based SSO: a `header` connection cannot be saved without a trusted proxy secret (422). The submitted `_legacy.trustedProxySecret` MUST be at least 32 characters and not the placeholder `replace-with-proxy-secret` published in earlier presets; only its digest (`sha256:v1:<hex>` in `_legacy.trustedProxySecretDigest`) is stored, and a stored placeholder never verifies. The proxy presents the secret in `X-Trusted-Proxy-Secret` (or `X-Forwarded-Auth-Secret`), compared in constant time. `POST /sso/header/:connectionId/authenticate` is rate limited through the RateLimitStore Durable Object per connection and source IP (scope `sso_header`, reset after a successful sign-in), and every failure before a verified identity (unknown connection, wrong secret, missing identity headers) returns the same 401 `invalid_credentials`.

Directory connectors: `POST /sso/directory-connectors/:connectionId/validate` requires an `sk_*` key with `connections:read` or a manager of the connection's Organization; `GET /sso/directory-connectors/types` lists the registry.

SWA is password vaulting for downstream applications that only offer a username and password form; it never signs a member in to XID. A signed-in, non-impersonated member of the connection's Organization stores their own downstream username and password through `POST /sso/swa/:connectionId/vault` (the session is checked before the body), reads whether credentials exist through `GET`, and removes them through `DELETE`. Credentials live in the `swa_credentials` table, one row per (tenant, connection, user), with username and password sealed together as one KEK envelope that also binds the connection and user IDs, so a row copied to another member fails to open; saves are tenant-bound UPSERTs. `GET /sso/swa/:connectionId/launch` returns a page that auto-submits the stored credentials to `_legacy.swaTargetUrl` using the configured `swaUsernameField` and `swaPasswordField` names. `GET /sso/swa/apps` lists the active SWA connections of the member's Organizations with the target origin and whether credentials are stored; the account portal's application sign-in section uses it to save, delete, and open each application.

WS-Federation callback: `wresult` is parsed as a WS-Federation 1.2 `wst:RequestSecurityTokenResponse` (WS-Trust 2005/02 or 1.3 namespace), optionally inside a `RequestSecurityTokenResponseCollection`, and `RequestedSecurityToken` MUST hold exactly one token. A SAML 2.0 assertion is verified with the assertion itself as the document root (no `samlp:Response` wrapper): the 9.2 structural allowlist, a required assertion signature under 9.3 to 9.5, Issuer equal to the connection's IdP entity ID, Audience equal to `wtrealm`, the 9.7 time windows, and exactly one AuthnStatement; `InResponseTo` MUST be absent, and SubjectConfirmationData `Recipient` is compared with the reply URL only when present, because AD FS often omits it. A SAML 1.1 assertion (`urn:oasis:names:tc:SAML:1.0:assertion`) requires an enveloped signature whose single Reference points at the root `AssertionID`, the `Issuer` attribute equal to the IdP entity ID, `Conditions/@NotOnOrAfter` (a missing `NotBefore` defaults to `IssueInstant`), `wtrealm` in every `AudienceRestrictionCondition`, a bearer confirmation method, the same subject in every statement, and an `AuthenticationInstant` not in the future; its attributes are keyed `AttributeNamespace/AttributeName`, matching the claim URIs AD FS emits in SAML 2.0. Both versions use the 9.4 digest and signature allowlist, so an AD FS relying party still signing with SHA-1 is rejected and must be switched to SHA-256. Attributes go through the connection's attribute mapping and `idpId` rule. `wctx` is compared only with the server-side flow stored in the OAuth flow Durable Object (single use, same connection) and never with the token; a callback without `wctx` is IdP-initiated and is accepted only when `_legacy.wsfedAllowIdpInitiated` is `true`. The connection MUST have IdP certificates configured, and development and tests use the same verification path (the fake WS-Fed IdP emits signed RSTRs). Assertion replay is tracked as in 9.7.

Still unsupported: linked sign-on, native IWA/Kerberos termination, non-HTTP LDAP sockets, and real
Kerberos constrained delegation. Kerberos ships as deployment-pattern documentation only; XID does not
implement a KDC or SPNEGO inside Workers.

## 7.2 Kerberos / IWA deployment patterns (documentation only)

XID does not terminate Kerberos/SPNEGO inside Cloudflare Workers and does not act as a KDC. The
recommended deployment patterns:

1. The customer deploys Entra Application Proxy, an AD FS proxy, or a third-party Kerberos bridge on
   their internal network, converting Windows Integrated Authentication into header-based SSO or
   SAML/OIDC federation.
2. A trusted reverse proxy injects only already-verified `X-Remote-User` / `X-Remote-Email` headers
   into XID, carrying an `X-Trusted-Proxy-Secret` that matches the connection configuration.
3. When full federation is needed, prefer a SAML 2.0 or OIDC upstream connection rather than exposing
   a Kerberos bridge directly to the public Worker.

This pattern matches Microsoft Entra's planned SSO deployment guidance: IWA/Kerberos is an edge-side
or IdP-side capability, and XID only consumes the trust result that was already established. Real
Kerberos L4 evidence requires the customer's proxy, a KDC, SPNs, and browser/IWA experiment results.

## 8. Technical constraint: SAML on Cloudflare Workers (P0 risk)

SAML depends on XML-DSig, C14N, and XML parsing, none of which Workers supports natively, so the
library must be pure JavaScript.

### Library evaluation

- @boxyhq/saml-jackson (Ory Polis): unusable. It is a complete middleware service with a hard
  dependency on persistent database TCP connections; the architecture does not suit Workers, and the
  project officially recommends running it as a standalone service
- samlify: unusable directly. It depends on xsd-schema-validator, which shells out to the native
  xmllint binary that Workers cannot execute. Forcing an empty validator introduces signature wrapping
  risk
- @node-saml/node-saml: unusable directly. The underlying xml-crypto depends on node:crypto's
  createVerify/createSign and on @xmldom/xmldom. Workers nodejs_compat has supported full node:crypto
  since 2025-04, but the node-saml call paths would need to be verified free of OpenSSL-specific calls
- xmldsigjs (PeculiarVentures): the most viable. It is built on WebCrypto (crypto.subtle), which
  Workers supports natively; XML parsing uses @xmldom/xmldom (pure JavaScript and bundleable); its
  bundled node-webcrypto-ossl MUST be marked external or ignored in esbuild and Workers native crypto
  injected through `Application.setEngine`; and the C14N namespace handling needs verification against
  OpenSSL

### Conclusion

Recommended approach: build the SAML processing layer in-house on xmldsigjs plus @xmldom/xmldom.

1. Mark node-webcrypto-ossl external in the bundle and inject Workers native crypto as the WebCrypto
   engine
2. @xmldom/xmldom provides the DOMParser
3. Enable nodejs_compat (compatibility date >= 2025-04-08)
4. Before launch, run assertion signature verification round-trip tests against real Okta, Azure AD,
   and Google Workspace IdPs

Alternative (higher reliability): push SAML processing down into a Durable Object or a standalone
Node sidecar, leaving the Worker to handle routing and sessions only, which sidesteps the
compatibility risk entirely.

Not recommended: running samlify on Workers with XSD validation disabled (the signature wrapping risk
is unacceptable).

Spike complete: the SAML processing layer shipped in `packages/saml` following the recommended
approach (xmldsigjs + @xmldom/xmldom, `setEngine` injecting Workers native crypto, nodejs_compat >=
2025-04-08), and all SSO endpoints pass. Round-trip assertion signature verification against real
Okta, Azure AD, and Google Workspace IdPs is still pending L4. This section is the architecture
selection record; the byte-level signature verification, decryption, and SCIM specifications from
section 9 onward are the implementation contract after shipping, and the step sequences and error
branches in those specifications are unchanged.

## 9. SAML Response signature verification implementation spec (P0)

The implementation lives in `packages/saml`. Libraries: `xmldsigjs` (PeculiarVentures) for XML-DSig
and `@xmldom/xmldom` for the DOMParser. On Worker startup, call
`Application.setEngine("webcrypto", crypto)` exactly once to inject Workers native `crypto.subtle`,
and mark the bundled `node-webcrypto-ossl` external or ignored (see section 8). This section draws on
SAML 2.0 Core (saml-core-2.0-os), XML-DSig (W3C xmldsig-core), the OWASP SAML Security Cheat Sheet,
and the XML Signature Wrapping (XSW) and Void Canonicalization attack surface (PortSwigger's "The
Fragile Lock" 2025, and the WorkOS SAML signature blog post).

### 9.0 Entry point and decoding

ACS endpoint: `POST /saml/acs/{connection_id}` with
`Content-Type: application/x-www-form-urlencoded`.

1. Read the `SAMLResponse` form field. Under the HTTP-POST binding the value is base64 (not base64url,
   so **do not URL-decode and then treat it as base64url**); DEFLATE only appears under the
   HTTP-Redirect binding, which is used for LogoutRequest and LogoutResponse and never for the
   Response. A base64 decode failure returns 400.
2. Read `RelayState` (<= 2 KB; anything longer is truncated and logged, per the decisions in section
   1). RelayState is not covered by the signature, so it **MUST NOT** drive any security decision; it
   is used only for the return redirect.
3. Decoding yields the XML byte string. **Run the safety pre-checks before parsing** (see 9.1).

### 9.1 Pre-parse safety checks (XXE / DTD / entity expansion defense)

Scan the raw string before `DOMParser.parseFromString`. Any hit rejects the request (returning 400
with `error=malformed_xml`):

- Contains `<!DOCTYPE` or `<!ENTITY` -> reject (DTDs are forbidden, which defends against XXE and
  entity expansion; the same hardening as PortSwigger 1.12.4).
- Contains an external entity reference or the processing instruction `<?xml-stylesheet` -> reject.
- `@xmldom/xmldom` configuration: do not resolve external resources (pure JavaScript has no network
  access so SSRF is impossible anyway, but DTDs are still disabled explicitly).

After parsing, assert that the document is well-formed with a single root element `samlp:Response` (namespace `urn:oasis:names:tc:SAML:2.0:protocol`); otherwise return 400. WS-Federation tokens are verified with the SAML 2.0 or SAML 1.1 `Assertion` as the root element instead (section 7.1).

### 9.2 XSD schema validation (mandatory, cannot be disabled)

Use a **local, trusted, pinned** SAML 2.0 schema (`saml-schema-protocol-2.0.xsd` plus
`saml-schema-assertion-2.0.xsd` plus `xmldsig-core-schema.xsd`); fetching a schema from a third-party
URL at runtime is forbidden. Harden the schema: remove or tighten extension points such as `xs:any`
and `processContents="lax"` (the anyType in `Extensions`, `StatusDetail`, and `AttributeValue`) so an
attacker cannot inject an `Extensions` node ahead of the signature (the injection point used by Void
Canonicalization).

Note: section 8 established that Workers cannot run the native xmllint binary. This step uses a pure
JavaScript schema validator (making structural assertions against the `@xmldom/xmldom` DOM) or
evaluates a pure JavaScript XSD library during the spike. If no pure JavaScript XSD option is
available, **degrade to hard-coded structural allowlist assertions on the critical path**, permitting
only known elements at fixed positions inside Response and Assertion. Unknown extension points are
never let through. This is P0 and "let it through now, handle it later" is not acceptable.

The same closed grammar applies to SLO under both HTTP-POST and HTTP-Redirect. It MUST run immediately
after secure parsing and before selecting or verifying any embedded or Redirect-binding signature.
Every binding field is unique; duplicate `SAMLRequest`, `SAMLResponse`, or `RelayState` values reject.
HTTP-Redirect verification signs the exact percent-encoded wire values rather than values
re-serialized through a query parser. A LogoutRequest is accepted only inside its bounded
IssueInstant/NotOnOrAfter window, and its request ID is claimed once until that window expires.
The accepted `LogoutRequest` sequence is `Issuer`, optional `ds:Signature`, `NameID`, then zero or
more protocol-namespace `SessionIndex` children. The accepted `LogoutResponse` sequence is `Issuer`,
optional `ds:Signature`, then `Status`. Both roots use a closed attribute allowlist, require `ID`,
`Version="2.0"`, and a valid `IssueInstant`; `LogoutResponse` also requires `InResponseTo`.
`Extensions`, unknown or duplicate children, mixed content, and a signature moved outside its fixed
position all reject with `schema_invalid` before signature verification.

### 9.3 Selecting the signature node (envelope versus assertion precedence)

SAML allows signing the Response, the Assertion, or both. There are two connection-level switches, `want_authn_response_signed` and `want_assertions_signed`. Both columns default to true; the IdP presets set them to the layer each IdP signs by default (Entra, Google Workspace, AD FS, Shibboleth, JumpCloud, OneLogin, and PingFederate sign the Assertion only; Keycloak signs the Response only). The switches select which layers are checked:

- Only `want_authn_response_signed`: the Response MUST carry a valid signature.
- Only `want_assertions_signed`, or both switches false: the consumed Assertion MUST carry a valid signature. Both false is treated as assertion-required, so verification can never be skipped.
- Both switches true: a valid signature on either layer is sufficient, because most IdPs sign only one layer by default. A Response signature covers the consumed Assertion: its Reference is pinned to the Response root and the structural allowlist permits exactly one assertion child.
- A checked layer that carries a signature MUST verify; a broken signature fails the Response even when the other layer verified. When no checked layer carries a signature the result is `signature_required`.

Hard rules for node location (XSW defense, following OWASP and PortSwigger):

1. **Never use `getElementsByTagName("Signature")` or `getElementsByTagName("Assertion")` and take the
   first match.**
2. Locate candidate signatures with an absolute XPath that pins the parent-child relationship: the
   Response signature MUST be `/samlp:Response/ds:Signature` (a direct child, not an arbitrary
   descendant), and the Assertion signature MUST be `/samlp:Response/saml:Assertion/ds:Signature` (or
   a direct child of the decrypted Assertion). Namespace prefixes are resolved through registered,
   fixed namespace URIs and never through the literal prefixes declared in the document.
3. Each checked node has **at most one** direct `ds:Signature` child: zero is resolved by the layer rule above, and more than one rejects.
4. `ds:SignedInfo` MUST contain **exactly one** `ds:Reference` (multiple References reject, defending
   against complexity and wrapping attacks).
5. `ds:Reference` MUST have **at most 2** Transforms, and only `enveloped-signature`
   (`http://www.w3.org/2000/09/xmldsig#enveloped-signature`) plus exclusive C14N
   (`http://www.w3.org/2001/10/xml-exc-c14n#`; the `...#WithComments` variant is rejected) are
   permitted. Any XSLT or XPath transform rejects.

### 9.4 Verifying References (signature wrapping and Void Canonicalization defense)

For the selected signature node:

1. Read `ds:Reference/@URI`, which MUST be a same-document fragment reference of the form `#<id>`.
   **An empty URI (whole document), a relative URI, and an absolute URL are all forbidden**, because
   relative and external URIs cannot be resolved during c14n and are the entry point for Void
   Canonicalization. `URI=""` rejects.
2. Parse `<id>` and locate that element in the document by its `ID`-typed attribute, exactly.
   Requirements:
   - **That `id` MUST be unique across the whole document** (a `document.querySelectorAll([ID="<id>"])`
     count MUST equal 1; more than 1 rejects). The XSD declares the `ID` on Assertion and Response as
     type `xs:ID`, and the DOM identifies ID attributes from that, so this **does not rely on an
     ordinary attribute that happens to be named "ID"** (defending against namespace-agnostic getter
     bypasses).
   - The referenced element MUST be the parent of the signature node from 9.3 (an enveloped signature
     lives inside the element it signs). A mismatch rejects.
3. Execute the Transforms (remove the Signature subtree for enveloped, then exclusive C14N) and compute
   the `DigestValue`. C14N MUST use the algorithms declared in `ds:Reference/ds:DigestMethod` and
   `ds:SignedInfo/ds:CanonicalizationMethod`. **When the c14n implementation encounters an
   unresolvable URI or any error, it MUST throw and the verification MUST fail; it MUST NEVER return
   an empty string** (this is the root cause of Void Canonicalization: silently returning an empty
   string means a digest is computed over empty input).
4. Compare the computed digest against `ds:DigestValue` in **constant time**; a mismatch rejects.
5. Algorithm allowlist for `ds:DigestMethod` and `ds:SignatureMethod`: digests are limited to SHA-256,
   SHA-384, and SHA-512 (SHA-1 is rejected); signatures are limited to RSA-SHA256, RSA-SHA384,
   RSA-SHA512, and ECDSA-SHA256 or stronger (rsa-sha1 is rejected). An algorithm outside the allowlist
   rejects with `error=weak_algorithm`.

### 9.5 Verifying the SignatureValue

1. Obtain the verification certificate: **use only the IdP certificate stored in the connection
   configuration** (the X.509 persisted during metadata import) and **ignore the document's own
   `ds:KeyInfo` and `ds:X509Certificate`** (following OWASP's StaticKeySelector guidance: when a single
   signing key is expected, obtain it from the IdP directly, store it locally, and ignore the KeyInfo
   in the document). During certificate rotation the connection stores both the old and new
   certificates, and verification against either one is sufficient.
2. Canonicalize `ds:SignedInfo` with the algorithm its `ds:CanonicalizationMethod` declares and verify `ds:SignatureValue` with the certificate's public key (`crypto.subtle.verify`, RSASSA-PKCS1-v1_5 + SHA-256 and so on). Failure rejects. Inbound `SignedInfo` may use exclusive C14N (`http://www.w3.org/2001/10/xml-exc-c14n#`) or inclusive C14N 1.0 (`http://www.w3.org/TR/2001/REC-xml-c14n-20010315`); any other method fails the structural check. Reference Transforms remain limited to step 5 of 9.3. Every embedded XML signature XID emits (AuthnRequest, Response, Assertion, status Response, LogoutRequest, LogoutResponse) sets exclusive C14N on `SignedInfo` explicitly, because xmldsigjs defaults `SignedInfo` to inclusive C14N (PeculiarVentures/xmldsigjs issues [#64](https://github.com/PeculiarVentures/xmldsigjs/issues/64) and [#59](https://github.com/PeculiarVentures/xmldsigjs/issues/59)); inclusive output includes in-scope ancestor namespaces, so a signed Assertion moved into another envelope would stop verifying. Regression samples signed outside xmldsigjs cover a default-namespace Assertion signed in place inside a Response (AD FS style), a Response-level signature over a prefixed Assertion, and an inclusive-C14N `SignedInfo` verified in its signing context. `UNKNOWN`: a real IdP sample combining inclusive C14N `SignedInfo` with a default-namespace Assertion signed in place has not been verified; such a Response from a real IdP could fail verification, and capturing and verifying one closes this item.
3. Certificate validity: check `notBefore` and `notAfter`, using the connection's
   `saml_clock_skew_ms` tolerance. The default is `180000` (+-3 minutes), the accepted range is
   `0..300000`, and the same value is used for Assertion time checks. During rotation, invalid
   certificates are ignored and any currently valid configured certificate may verify the
   signature. Revocation checking (CRL/OCSP) is P1; the first release records the certificate
   fingerprint for incident response.
4. **Once the signature verifies, extract data only from the element corresponding to the verified
   signature node** (the Assertion located in 9.4 step 2). Never call a document-wide
   `getElementsByTagName` again to fetch the NameID or Attributes. This is the last line of XSW
   defense: verifying the right signature but then reading the wrong node.

### 9.6 EncryptedAssertion decryption

When the Response contains a `saml:EncryptedAssertion` in place of a plaintext Assertion:

1. Locate `/samlp:Response/saml:EncryptedAssertion/xenc:EncryptedData` (an absolute path, unique).
2. Locate `xenc:EncryptedKey`: inline in `xenc:EncryptedData/ds:KeyInfo` (more than one inline key rejects); otherwise a sibling under `saml:EncryptedAssertion`, selected by the `ds:RetrievalMethod` URI (which MUST match exactly one sibling `Id`) or, without a RetrievalMethod, the single sibling.
3. Unwrap the session key with the SP decryption private key (the connection-level SP decryption key, which may or may not be the same as the SP signing key, stored encrypted in the CertStore, see section 1) through `crypto.subtle.decrypt` with `RSA-OAEP`. The OAEP hash comes from the EncryptedKey's `xenc:EncryptionMethod`, and the private key is imported as a non-extractable key for that hash on every message:

   | Key transport `Algorithm`                         | OAEP digest (`ds:DigestMethod`)                    | MGF1 digest                                                   |
   | ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
   | `http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p` | SHA-1 by default, or SHA-1/256/384/512 if declared | Always SHA-1; an `xenc11:MGF` child rejects                   |
   | `http://www.w3.org/2009/xmlenc11#rsa-oaep`        | SHA-1 by default, or SHA-1/256/384/512 if declared | `xenc11:MGF` (`mgf1sha1`/`256`/`384`/`512`), SHA-1 by default |

   Web Crypto uses one hash for OAEP and MGF1, so a combination with different digests (for example SHA-256 OAEP with MGF1 SHA-1) rejects with `decryption_failed`; Okta, AD FS, and Shibboleth defaults (`rsa-oaep-mgf1p` with SHA-1) are accepted. `xenc:OAEPparams` is passed as the OAEP label. SHA-1 is accepted here only for key transport; the signature digest allowlist in 9.4 still rejects it.

4. Decrypt `xenc:CipherValue` with the session key. The data algorithm MUST be `aes128-gcm` or `aes256-gcm` (XML Encryption 1.1) or `aes128-cbc` or `aes256-cbc` (XML Encryption 1.0), and the session key length MUST match it. The IV is the ciphertext prefix (12 bytes for GCM, 16 for CBC). CBC padding follows XML Encryption section 5.2: only the last byte is read as the padding length, so ISO 10126 random padding written by Santuario and .NET is accepted. The session key bytes are zeroed after use. The result is the plaintext Assertion XML bytes.
5. Run the plaintext Assertion back through the 9.1 safety pre-checks and 9.2 schema validation, then parse it into a DOM.
6. **The decrypted Assertion goes through the same layer rule as 9.3**: its signature node is the direct `ds:Signature` child of the plaintext Assertion, and the referenced ID is unique within the plaintext Assertion document. When the Response layer is not checked, an unsigned decrypted Assertion fails with `signature_required`. When both layers are checked, a valid Response signature is sufficient because its digest covers the EncryptedAssertion ciphertext, so the inner payload cannot be swapped; a signature present on the decrypted Assertion must still verify.
7. Ordering: **decrypt first, then verify** (decrypt-then-verify), because the signature is invisible
   inside the ciphertext. However, the SP private key used for decryption and the IdP public key used
   for verification are two separate keys: a successful decryption does not imply trust, and signature
   verification is the trust anchor.

### 9.7 Assertion semantic validation (after signature verification passes)

Validate the verified Assertion in order; any failure returns per 9.8. Every time field is checked against its own meaning in SAML Core with the connection's `saml_clock_skew_ms` tolerance (default +-3 minutes, maximum +-5 minutes); an upper bound named `NotOnOrAfter` is exclusive. A time attribute that is present but not a valid date-time fails closed.

1. `samlp:Response/samlp:Status/samlp:StatusCode/@Value` equals `urn:oasis:names:tc:SAML:2.0:status:Success`, otherwise handle it as an IdP-reported error (403). A present `samlp:Response/@Destination` MUST equal our ACS URL. Both checks apply only when a Response wraps the Assertion.
2. `saml:Issuer` equals the IdP EntityID configured on the connection (exact string match).
3. `saml:Conditions` is required (SAML Core 2.5.1). Its `@NotBefore` and `@NotOnOrAfter` are each optional; a missing `@NotBefore` takes the Assertion `@IssueInstant`, which MUST be valid. The Assertion is rejected when `now + skew < NotBefore` or `now - skew >= NotOnOrAfter`.
4. `saml:Conditions/saml:AudienceRestriction/saml:Audience` contains this SP's EntityID (the SP EntityID corresponding to our ACS, taken from TenantContext plus the connection).
5. `saml:Subject/saml:SubjectConfirmation` MUST use the bearer method and carry `saml:SubjectConfirmationData` (SAML Core 2.4.1.2). On the ACS its `@Recipient` MUST be present and equal our ACS URL exactly; WS-Federation compares it only when present (section 7.1). `@NotOnOrAfter` is required and MUST not have passed; an optional `@NotBefore` MUST not be in the future. A present `@InResponseTo` MUST equal an AuthnRequest ID that we issued and have not consumed (stored in a Durable Object, single use); an Assertion without it is handled as IdP-initiated.
6. A login Assertion MUST contain exactly one `saml:AuthnStatement` with a valid `@AuthnInstant` (SAML Core 2.7.2). `@AuthnInstant` is the moment the user actually authenticated, so it only MUST NOT be later than `now + skew`; it may be hours earlier than `Conditions/@NotBefore` when the IdP reuses an existing session. An optional `@SessionNotOnOrAfter` that has passed rejects, because the IdP session has ended. Missing, duplicate, or malformed authentication statements fail closed.
7. Replay defense: claim `Assertion/@ID` in the consumed set held by the `ChallengeStore` Durable Object. The key is kept until the latest moment the Assertion could still be accepted: TTL = min(`Conditions/@NotOnOrAfter`, `SubjectConfirmationData/@NotOnOrAfter`) + the maximum clock skew (5 minutes) - now. The `ChallengeStore` `/claim` action accepts a TTL of at most 24 hours (`SAML_ASSERTION_REPLAY_MAX_TTL_MS`) and returns 400 for an out-of-range TTL instead of substituting a default; an Assertion whose replay TTL would exceed 24 hours is rejected with 403 `assertion_expired` rather than stored with a shortened window. A repeat claim rejects with `replay_detected`. WS-Federation assertions use the same rule.
8. Extract the idp_id (the NameID, or the configured `idpId` attribute, see section 1) and the mapped attributes (email, firstName, lastName, groups) and enter JIT provisioning (section 4).

### 9.8 ACS endpoint error branches (HTTP status mapping)

Error responses uniformly render the hosted error page (never leaking internal detail to the browser)
while writing an audit entry plus a structured log. Status codes:

| Branch                              | Condition                                                                                                             | HTTP | Internal error code                      | Notes                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------- | ------------------------------------------------ |
| Malformed request                   | SAMLResponse missing, base64 decode failure, XML not well-formed, or a DTD pre-check hit                              | 400  | `malformed_request` / `malformed_xml`    | Never reaches signature verification             |
| Schema validation failure           | XSD or the structural allowlist did not pass                                                                          | 400  | `schema_invalid`                         | Blocks the XSW injection point                   |
| Signature missing                   | No layer that 9.3 checks carries a signature, so none can be verified.                                                | 401  | `signature_required`                     |                                                  |
| Signature invalid                   | DigestValue mismatch, SignatureValue verification failure, weak algorithm, illegal Reference, or an XSW detection hit | 401  | `signature_invalid`                      | Always 401; never differentiated for the browser |
| Decryption failure                  | EncryptedAssertion decryption failed or the algorithm is not on the allowlist                                         | 400  | `decryption_failed`                      |                                                  |
| Issuer mismatch                     | Assertion Issuer does not equal the configured IdP EntityID                                                           | 403  | `issuer_mismatch`                        |                                                  |
| Audience mismatch                   | AudienceRestriction does not include this SP                                                                          | 403  | `audience_mismatch`                      |                                                  |
| Assertion expired                   | NotBefore, NotOnOrAfter, or SubjectConfirmation is outside its time window                                            | 403  | `assertion_expired`                      |                                                  |
| Recipient/InResponseTo mismatch     | Recipient is not the ACS, or InResponseTo is unknown or already consumed                                              | 403  | `recipient_mismatch` / `replay_detected` |                                                  |
| Replay                              | The Assertion ID was already consumed                                                                                 | 403  | `replay_detected`                        |                                                  |
| IdP reported an error               | StatusCode is not Success                                                                                             | 403  | `idp_status_<status>`                    | The IdP status code is passed through to the log |
| JIT disabled and the user is absent | The connection forbids JIT and no User matches the idp_id                                                             | 403  | `provisioning_disabled`                  | See section 4                                    |
| Server error                        | The decryption key is unavailable, or an internal exception occurred                                                  | 500  | `internal_error`                         |                                                  |

Success: establish the session and 302 to the landing page. An SP-initiated sign-in resumes the flow stored with its AuthnRequest; an IdP-initiated sign-in uses the RelayState when it resolves to the instance issuer origin, otherwise the connection's `relay_state_url`, otherwise the default post-sign-in page (section 1).

Convention: `signature_required` and `signature_invalid` use 401 (authentication failure); semantic
validation failures (issuer, audience, expiry, recipient, replay) use 403 (authenticated but the
assertion is unacceptable); request and ciphertext format failures use 400.

### 9.9 Required fields in the SP metadata XML

`GET /saml/metadata/{connection_id}` emits the SP metadata
(`Content-Type: application/samlmetadata+xml`). Required:

- `md:EntityDescriptor/@entityID`: this SP's EntityID (either
  `https://{tenant}.xid.dev/saml/{connection_id}` or the custom domain, taken from TenantContext, so
  it is tenant-isolated).
- `md:SPSSODescriptor/@protocolSupportEnumeration` = `urn:oasis:names:tc:SAML:2.0:protocol`.
- `md:SPSSODescriptor/@AuthnRequestsSigned` (true exactly when the tenant has an active `saml_sp_signing` certificate, which is also the condition under which SP-initiated AuthnRequests are signed) and `@WantAssertionsSigned` (= want_assertions_signed).
- `md:SPSSODescriptor/md:KeyDescriptor[@use="signing"]`: the SP signing certificate
  (`ds:X509Certificate`, base64 DER, without PEM headers).
- `md:SPSSODescriptor/md:KeyDescriptor[@use="encryption"]`: the SP encryption certificate (required
  when EncryptedAssertion is supported) plus `md:EncryptionMethod` (declaring the supported AES and
  RSA-OAEP variants).
- `md:SPSSODescriptor/md:AssertionConsumerService`: `@Binding` =
  `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST`, `@Location` = the ACS URL, `@index="0"`,
  `@isDefault="true"`.
- `md:SPSSODescriptor/md:NameIDFormat`: the accepted NameID formats (at minimum
  `urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress` and `...:persistent`).
- Optional but recommended: `md:SingleLogoutService` (SLO, P1), `md:Organization`, and
  `md:ContactPerson`.
- Signing the metadata itself (`md:EntityDescriptor/ds:Signature`) is P1 (some IdPs require it) and
  can be omitted in the first release.

## 10. SCIM 2.0 implementation spec (against RFC 7644, P0)

The implementation lives in `apps/server/worker`, with the public endpoint prefix
`/scim/v2/organizations/{organization_id}/` (see section 6) and the media type
`application/scim+json`. Internally the implementation still uses `tenant_id` as the organization
isolation field. Error body format (RFC 7644 3.12):

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "scimType": "<keyword>",
  "detail": "<human readable>",
  "status": "<http status as string>"
}
```

`scimType` is used only for 400 (invalidFilter, invalidPath, invalidValue, invalidSyntax, mutability,
noTarget, tooMany, sensitive) and 409 (uniqueness). For every other status (401/403/404/500)
`scimType` is omitted, and the `status` field is always the HTTP status code rendered as a string.

### 10.1 PATCH handling pseudocode (RFC 7644 3.5.2)

The request body's `schemas` contains
`urn:ietf:params:scim:api:messages:2.0:PatchOp`, plus an `Operations` array whose entries are
`{op, path?, value?}`. `op` takes `add`, `remove`, or `replace` (case-insensitive).

```
function handlePatch(tenant_id, resource_type, resource_id, body):
  # 10.1.0 authentication + isolation
  directory = authBearer(tenant_id)                 # see 10.3; failure returns 401
  resource = repo.find(resource_type, resource_id, where tenant_id, directory.id)
  if resource is null: return 404                   # do not leak existence; cross-tenant is also 404
  if body.schemas does not contain PatchOp:
    return 400 scimType=invalidSyntax

  applied = false
  staged = clone(resource)                           # persist only if every op succeeds (atomic)

  for opItem in body.Operations:
    op = lowercase(opItem.op)
    if op not in {add, remove, replace}:
      return 400 scimType=invalidSyntax
    if op == remove and opItem.path is absent:
      return 400 scimType=noTarget                   # remove requires a path
    # path parsing: RFC 7644 attrPath / valuePath, such as members / name.givenName /
    #   emails[type eq "work"].value
    target = parsePath(opItem.path)                   # a parse failure returns 400 invalidPath
    if opItem.path present and target is null:
      return 400 scimType=invalidPath

    switch op:
      case add:
        if target.isMultiValued (such as members):
          # Idempotent: skip a member that already exists, without erroring (see unknown member in 10.1.1)
          for v in asArray(opItem.value):
            if not staged[target].containsByValue(v):
              staged[target].append(resolveMember(v))   # unknown member handling below
        else if target has filter and no match:
          # seed one element from the filter's `attr eq "x"` conjunction, otherwise noTarget
          if filter is not an eq conjunction: return 400 scimType=noTarget
          staged[target].append(seedFromFilter(target.filter)) then set target.sub
        else:
          if target.attr is readOnly: return 400 scimType=mutability
          if value type mismatch:     return 400 scimType=invalidValue
          staged.set(target, opItem.value)
      case replace:
        if opItem.path absent:
          # replace without a path: value is an attribute map, replaced attribute by attribute
          mergeTopLevel(staged, opItem.value)
        else:
          if target.attr is readOnly: return 400 scimType=mutability
          if target.isMultiValued and target has filter and no match:
            # a filtered path with no match -> noTarget
            return 400 scimType=noTarget
          staged.set(target, opItem.value)
      case remove:
        if target.isMultiValued and target has filter and no match:
          # Idempotent: the member to remove was never there -> treat as success (200), not noTarget
          continue                                      # see 10.1.1
        if not staged.has(target):
          continue                                      # idempotent no-op removal
        staged.unset(target)
    applied = true

  if validation(staged) fails uniqueness (userName/externalId among non-deleted users):
    return 409 scimType=uniqueness
  repo.save(staged, where tenant_id, directory.id)      # isolation filter injected automatically
  emitWebhook(resourceChangedEvent(staged))             # asynchronous, see 10.2
  if request has header "Prefer: return=minimal":
    return 204
  return 200 with body = scimRepr(staged)               # including the updated meta.version (ETag)
```

Key points:

- The whole Operations batch is applied or none of it is (a staged copy, persisted once at the end).
  If any op returns an error mid-way, **nothing is persisted**.
- Paths are parsed by the same lexer and recursive-descent parser as filters (10.5): an attribute with an optional `.sub` sub-attribute, a schema URN prefix such as the enterprise User extension (`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department`), and a value path `attr[filter]` with an optional `.sub`. Keys of a path-less value map go through the same parser: a dotted or URN key is applied as a path, an object under the core schema URN is merged into the root, and an object under an extension URN is expanded key by key.
- An unrecognized `op` or a malformed body returns `invalidSyntax`; a path syntax error returns `invalidPath`; a filtered path with no match returns `noTarget` under replace and under add when the filter is not an `eq` conjunction; a path-less remove returns `noTarget`; a wrong value type or a missing required value returns `invalidValue`. `id` equal to the current resource ID is ignored (Okta sends it when renaming a Group), while a different `id` returns `mutability`; `meta` and `schemas` in a value map are ignored.
- Group member removal accepts `members[value eq "<id>"]`, including several conditions joined with `or`; removing a member that is not present succeeds.
- Case sensitivity: SCIM attribute names are caseExact=false (with specific exceptions), and the `op` keyword is case-insensitive.

### 10.1.1 Unknown member idempotency path (the OneLogin ordering quirk, see the decisions in section 6)

When adding members, `value` looks like `[{"value":"<user_id_or_externalId>"}]`, but that user may not
have been created by SCIM yet (OneLogin can PATCH the Group members before POSTing the User):

```
function resolveMember(memberValue):
  ref = memberValue.value
  user = repo.findDirectoryUser(ref) or repo.findByExternalId(ref)
  if user exists:
    member = {value: user.id, display: user.userName, type: "User"}
  else:
    # Do not error and do not create a shell user; record a pending membership (directory_pending_members)
    # and backfill the group relationship when that user is later created by POST/PUT.
    # Idempotent: repeatedly adding the same ref does not create duplicate pending rows.
    member = {value: ref, "$pending": true}
    repo.upsertPendingMember(group_id, ref)            # unique constraint (group_id, ref)
  return member
```

A `remove` of members pointing at an unknown or already-absent member succeeds silently (continue) and
does not return noTarget. This implements the decision in section 6: "a PATCH of group members can
arrive before the user is created, so the server MUST handle an unknown member idempotently".

### 10.1.2 Deprovisioning operation sequence (active=false)

Trigger: `PATCH /Users/{id}` containing `{"op":"replace","path":"active","value":false}` (or a
path-less replace with `active=false`). **The XID User is not deleted** (this preserves the audit
trail, see the decisions in section 6). `DELETE /Users/{id}` runs the same deprovisioning security
sequence and additionally marks the DirectoryUser as deleted. The sequence:

```
1. [sync] Validate and parse the PATCH or PUT, locating active=false.
2. [sync] Persist DirectoryUser.active=false, DirectoryUser.status="deprovisioning".
3. [sync] Persist User.status=deactivated, only when it is currently active (D1, tenant_id filter).
         Synchronous persistence guarantees later token validation sees the latest state.
4. [sync] revokeAllSessions(user_id):
           - Call the per-user session revocation Durable Object (see chapter 05 and the cloudflare-bindings rule)
             to clear that user's active session_id set. DO memory updates first (effective within the 60s JWT window).
           - Mark D1 sessions.status=revoked.
           - Revoke every refresh token family for that user and deny its unexpired access tokens.
         Any failure returns 503 and leaves DirectoryUser.status="deprovisioning", so an IdP retry
         runs steps 3-4 again.
5. [sync] Persist DirectoryUser.status="deactivated" (DELETE: "deleted" plus the managed membership
         set to inactive).
6. [sync] Return 200 (or 204 with Prefer: return=minimal), with active=false in the body.
7. [async] emitWebhook("user.deactivated", {user_id, directory_id, org_id}):
           delivered through Queues, without blocking the SCIM response (exponential backoff, 5 attempts, dead letter to D1).
8. [async] Audit: append-only write of the deprovisioning event (Queues -> the audit consumer).
```

Synchronous versus asynchronous boundary: persisting the status and revoking sessions and refresh
tokens **MUST be synchronous** (the security semantics of deprovisioning are that returning 200 means
the account is already locked out, which cannot wait on async work); the webhook and audit entries are
**asynchronous** (they do not affect security and go through Queues). `DELETE /Users/{id}` returns 204
and writes `DirectoryUser.active=false`, `DirectoryUser.status=deleted`, and
`DirectoryUser.deleted_at=now`, without deleting the XID User. `DELETE /Groups/{id}` returns 204 and,
after clearing the group members, writes `DirectoryGroup.status=deleted` and
`DirectoryGroup.deleted_at=now`.

### 10.2 Bearer token hash storage and 30-minute rotation grace period

The per-directory SCIM bearer token (see section 6).

Storage:

- Generation: `scim_<32 random bytes, base64url>` (`crypto.getRandomValues`). The plaintext is shown
  exactly once.
- Persistence: **only the SHA-256 hash is stored** (`directory.scim_token_hash`); the plaintext never
  enters the database (mirroring password reset tokens, which are also hash-only, see the
  password-auth rule).
- Validation: take the `Authorization: Bearer <token>` header, compute SHA-256(token), and compare it
  in constant time against `scim_token_hash` (and against `scim_token_hash_prev` while the grace
  period lasts).

Rotation with a 30-minute grace period:

```
function rotateScimToken(directory_id):
  new = "scim_" + randomBase64Url(32)
  directory.scim_token_hash_prev    = directory.scim_token_hash      # the old hash becomes prev
  directory.scim_token_prev_expires = now + 30min                    # grace period end
  directory.scim_token_hash         = sha256(new)
  save(directory)
  return new   # the plaintext is returned this one time only

function authBearer(tenant_id):
  token = parseBearer(request)
  if token absent:        return 401  # WWW-Authenticate: Bearer
  h = sha256(token)
  dir = repo.findDirectoryByTenant(tenant_id)        # the path carries tenant_id, so it is isolated
  if dir is null:         return 401
  if constantTimeEq(h, dir.scim_token_hash):         return dir   # the new token
  if dir.scim_token_hash_prev is set
     and now < dir.scim_token_prev_expires
     and constantTimeEq(h, dir.scim_token_hash_prev):
                          return dir   # the old token, still valid during the grace period
  return 401
```

A Cron job (every 15 minutes, see Cron Triggers in the cloudflare-bindings rule) clears expired
`scim_token_hash_prev` values (setting them to null once `now >= scim_token_prev_expires`). A 401
response carries no scimType but does carry `WWW-Authenticate: Bearer`.

### 10.3 Example User response body

`GET /scim/v2/organizations/{organization_id}/Users/{id}` returns 200 with
`Content-Type: application/scim+json` and `ETag: W/"<meta.version>"`:

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "id": "2819c223-7f76-453a-919d-413861904646",
  "externalId": "701984",
  "userName": "bjensen@example.com",
  "name": {
    "givenName": "Barbara",
    "familyName": "Jensen",
    "formatted": "Barbara Jensen"
  },
  "emails": [{ "value": "bjensen@example.com", "type": "work", "primary": true }],
  "active": true,
  "title": "Engineer",
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
    "department": "Platform"
  },
  "meta": {
    "resourceType": "User",
    "created": "2026-06-01T08:00:00Z",
    "lastModified": "2026-06-01T08:00:00Z",
    "location": "https://xid.dev/scim/v2/organizations/{organization_id}/Users/2819c223-7f76-453a-919d-413861904646",
    "version": "W/\"a330bc54f0671c9\""
  }
}
```

Mapping (see attribute mapping in section 6): `emails[primary].value` (or an email `userName`) maps to
the primary email; a non-email `userName` maps to `username`; `name.givenName` and `name.familyName`
map to first and last name; `active` maps to User.status through the sequence in 10.1.2; the response
body is rendered from the stored DirectoryUser, including `externalId`, `title`, and
`enterprise.department`.

### 10.4 Example Group response body

`GET /scim/v2/organizations/{organization_id}/Groups/{id}` returns 200:

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "id": "e9e30dba-f08f-4109-8486-d5c6a331660a",
  "displayName": "Engineering",
  "members": [
    {
      "value": "2819c223-7f76-453a-919d-413861904646",
      "$ref": "https://xid.dev/scim/v2/organizations/{organization_id}/Users/2819c223-7f76-453a-919d-413861904646",
      "type": "User",
      "display": "bjensen@example.com"
    }
  ],
  "meta": {
    "resourceType": "Group",
    "created": "2026-06-01T08:00:00Z",
    "lastModified": "2026-06-01T08:05:00Z",
    "location": "https://xid.dev/scim/v2/organizations/{organization_id}/Groups/e9e30dba-f08f-4109-8486-d5c6a331660a",
    "version": "W/\"3694e05e9dff594\""
  }
}
```

`displayName` is unique within a directory and carries no role semantics (group-to-role mapping is
not implemented, see section 6); `members[].value` maps to DirectoryUser.id (an unknown member goes to
pending, see 10.1.1). Every Users and Groups query goes through the Drizzle tenant query layer, which
injects `WHERE tenant_id = ? AND directory_id = ?` (see the tenant-isolation rule), so cross-directory
and cross-tenant access returns 404 without leaking existence.

`POST /Users` and `POST /Groups` return 201 with `Location` (= `meta.location`) and `ETag` (= `meta.version`) headers (RFC 7644 3.3 and 3.14).

### 10.5 Filters, uniqueness, and Bulk

- Filters (RFC 7644 3.4.2.2) are tokenized first (quoted strings, parentheses, brackets, attribute paths, operators) and then parsed by recursive descent with precedence `not` > `and` > `or`, so a value containing `and` or `or`, such as `displayName eq "Brand Team"`, is not split. Operators are `eq`, `ne`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`, and `pr`; grouping, value paths (`emails[type eq "work"]`), sub-attributes, and schema URN prefixes are supported. A syntax error returns 400 `invalidFilter`.
- Uniqueness: see section 6. Deleted Users and Groups do not hold their `userName`, `externalId`, or `displayName`, so a deleted resource can be created again with the same values.
- Bulk (RFC 7644 3.7): `failOnErrors` MUST be a positive integer and is the error count after which the remaining operations are skipped; any other value, including `true`, returns 400 `invalidValue`. A `bulkId:<id>` reference in an operation path or anywhere in `data` is replaced with the ID of the resource created earlier in the same request; an unresolved reference fails that operation with 409. More than the advertised `maxOperations` returns 413 `tooMany`, and a payload over `maxPayloadSize` returns 413 `tooLarge`. Sub-requests run with the outer request's execution context, so their audit, webhook, and outbound SCIM background work stays alive after the Bulk response is sent.
