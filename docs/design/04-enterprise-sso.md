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
- IdP-initiated: accept an IdP POST to the ACS and decide the landing page from the connection's
  `relay_state_url`
- IdP metadata import: automatic fetch by URL (refreshed periodically) plus XML upload, parsing the
  entityID, SSO URL, SLO URL, and certificate
- Attribute mapping: standard fields (email, firstName, lastName, idp_id) automatically, plus
  administrator-configured custom fields
- Certificate management: an SP private key signs the AuthnRequest (optional); the IdP assertion
  signature MUST be verified; old and new certificates coexist during rotation; EncryptedAssertion is
  decrypted

### Design decisions

- Each org has exactly one SSO connection. A connection maps 1:1 to an org and is never reused across
  tenants
- The primary key is the idp_id (SAML NameID or OIDC sub). Matching on email alone is forbidden,
  because an email change would orphan the account
- RelayState is capped at 2 KB; anything longer is truncated and logged
- The IdP metadata URL is polled and refreshed every 24 hours, and a certificate change fires an alert
  webhook
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
- IdP signing certificate provisioning: creating a downstream SAML app without an explicit
  `idp_signing_cert_id` reuses a valid tenant certificate or generates one, stores it in
  `cert_store` with usage `saml_idp_signing`, and envelope-encrypts the private key under the
  Workers Secret KEK. Runtime signing accepts valid `active` and `retiring` certificates; automatic
  selection provisions from `active`, while `retiring` keeps an already configured app working
  during trust rollover. Validity is read from the X.509 certificate rather than trusting nullable
  database bounds. When the sole active IdP certificate is not yet valid or has 30 days or less
  remaining, provisioning atomically changes that exact certificate to `retiring` and inserts its
  replacement in one D1 batch. The active-certificate partial unique index applies only to
  `saml_idp_signing`; it never changes SP signing or encryption certificate state.
- SP registration: each downstream SaaS gets its own record of the ACS URL, SP EntityID, Audience,
  Recipient, attribute mapping, and NameID policy. ACS and optional SLO URLs MUST be public HTTPS at
  registration and are revalidated before assertion delivery or logout.
- SSO endpoint: accepts an SP-initiated SAMLRequest or an IdP-initiated app launch, and verifies the
  user session and org membership. SP-initiated requests pass the same secure XML precheck and a
  dedicated closed AuthnRequest grammar before exact Issuer, Destination, HTTP-POST binding, and ACS
  matching against the registered SP. Metadata currently advertises
  `WantAuthnRequestsSigned=false`; unsigned requests are therefore accepted, while any embedded
  XMLDSig or Redirect `Signature`/`SigAlg` that is present must verify against the SP certificates.
- Assertion issuance: signs the Response and the Assertion, and sets Issuer, Subject, NameID,
  AudienceRestriction, Recipient, Destination, NotOnOrAfter, email, and name.
- Verification: package-level XML signature tests, Worker route L2, and a fake SaaS SP at L3 are all
  covered. Real Slack, GitHub, Microsoft, Atlassian, Salesforce, and Zoom admin L4 evidence is still
  missing.
- Preset and assignment UI: Console provides Slack, GitHub Enterprise Cloud, Microsoft custom app,
  Atlassian, Salesforce, and Zoom presets, plus `all` or restricted user/role assignment gates.
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

- Target registration: each downstream SaaS gets its own record of the SCIM base URL, server-derived
  token secret reference, attribute mapping, group mapping, and assignment gate. The base URL MUST
  be public HTTPS.
- Token storage: the SaaS SCIM bearer token is held only in the target-specific Workers Secret
  `SCIM_TARGET_TOKEN_<normalized target id>`. The API returns that required name after target
  creation, rejects a caller-supplied `token_secret_ref`, and never lets tenant data select an
  arbitrary Worker binding. Logs and audit records MUST redact the token.
- Sync endpoints: `/scim/outbound/:targetId/sync` and
  `/v1/organizations/:orgId/scim-targets/:targetId/sync` authorize the caller, enqueue one
  `ScimSyncQueueMessage`, and return `202` with the stable `runId`; downstream HTTP never runs in the
  request path.
- Stable resource mapping: `scim_target_resources` binds each local User or role-derived Group to the
  downstream SCIM `id`. A retry first uses that mapping; when it is absent or stale, the consumer
  discovers by the deterministic `externalId` before creating anything. `POST` is therefore only the
  last step after a zero-result discovery, while mapped resources use `PUT`.
- Group payloads reference downstream User ids from the same target's mappings, never XID User ids.
- Safe deprovision: only after every currently eligible User and Group upsert succeeds may the
  consumer process mappings absent from the current Organization Membership plus assignment-gate
  intersection. Stale Users receive `PATCH active=false`; stale role Groups are replaced with an
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

- The first SSO sign-in creates the User automatically
- Attribute sync: every sign-in overwrites first_name, last_name, and custom_attributes from the
  latest SSOProfile
- Role mapping: IdP groups or attributes map to an org_role (configured per connection)
- Conflict handling: exact idp_id match > email association > create new
- JIT can be toggled per connection (some enterprises require SCIM-only control and forbid automatic
  JIT account creation)

Users created by JIT are tagged `provisioned_by: jit_sso`. Constraint: JIT only handles onboarding and
attribute updates; it cannot deprovision, so it MUST be paired with SCIM.

## 5. Domain-based routing / HRD

- Route by email domain to the corresponding org's SSO connection
- Domain verification: DNS TXT (`xid-verify=<token>`) or an HTTPS file
- A domain can be claimed by exactly one org, and wildcard subdomains are supported
- After the user enters an email on the sign-in page: look up the domain -> find the active connection
  -> redirect to the IdP
- Multiple domains per org; unverified domains do not trigger SSO routing

Data model: the core entity is OrganizationDomain (see chapter 08), which carries the domain
verification status and method.

Domain verification polling runs through Cron Triggers, checking pending domains every 15 minutes. A
verified domain is a precondition for JIT SSO.

## 6. SCIM 2.0 (Directory Sync)

### Capabilities

- Act as a SCIM 2.0 server accepting pushes from Okta, Azure AD, and Google Workspace
- Endpoint prefix: `/scim/v2/organizations/{organization_id}/`
- Standard endpoints: Users, Groups (GET/POST/PUT/PATCH/DELETE), ServiceProviderConfig, Schemas, and
  ResourceTypes
- Bearer token authentication: a per-directory token supporting rotation (with a 30-minute grace
  period for the old token)
- User provisioning: create, update, deactivate (`active=false`), and delete
- Group provisioning: create, update, delete, with incremental member PATCH
- Group-to-role mapping: Group displayName maps to an org role
- Webhooks: directory events pushed to the application endpoint
- Attribute mapping: userName, emails[primary], name.givenName, name.familyName, department, and title
  map onto XID fields

### Design decisions

- SCIM User and XID User are bound bidirectionally (through the directory_user_id foreign key)
- Deprovisioning (`active=false`) revokes every session token but does not delete the XID User (which
  preserves the audit trail). `DELETE /Users/{id}` maps to a directory user soft delete and never
  physically deletes the XID User
- OneLogin quirk: a PATCH of group members can arrive before the user is created, so the server MUST
  handle an unknown member idempotently
- A Group displayName change MUST update the role mapping in step

### Data model

The core entities are Directory, DirectoryUser, and DirectoryGroup (see chapter 08): the directory
connection, the synced users and groups, and the group-to-role mapping.

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
| SWA / password vaulting       | `POST /sso/swa/:connectionId/authenticate`, `POST /sso/swa/:connectionId/vault`                | fake SWA harness L3              | Needs a real target app admin and vault rotation L4                            |
| Header-based SSO              | `POST /sso/header/:connectionId/authenticate`                                                  | route tests L2                   | Needs a trusted reverse proxy / Application Proxy and real header injection L4 |
| Directory connector framework | `GET /sso/directory-connectors/types`, `POST /sso/directory-connectors/:connectionId/validate` | connector registry + validate L2 | SQL/REST/SOAP/PowerShell/ECMA connectors are still stubs                       |

Connection configuration still uses `sso_connections`, where `protocol` takes the values `ldap`,
`wsfed`, `swa`, or `header`, and the protocol-specific detail lives in `attributeMapping._legacy`.
SWA vault credential hashes and envelope-encryption metadata live in `attributeMapping._swaVault` and
`_swaVaultEnvelope`. Every query still goes through the tenant query layer, a connection maps 1:1 to
an org, and cross-tenant reuse is forbidden.

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

After parsing, assert that the document is well-formed with a single root element `samlp:Response`
(namespace `urn:oasis:names:tc:SAML:2.0:protocol`); otherwise return 400.

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

SAML allows signing the Response, the Assertion, or both. There are two connection-level switches
(both default to true, see certificate management in section 1):

- `want_authn_response_signed` (default true): require the Response node to be signed.
- `want_assertions_signed` (default true): require every consumed Assertion to be signed (a plaintext
  Assertion obtained by decrypting an EncryptedAssertion is held to the same requirement).

Hard rules for node location (XSW defense, following OWASP and PortSwigger):

1. **Never use `getElementsByTagName("Signature")` or `getElementsByTagName("Assertion")` and take the
   first match.**
2. Locate candidate signatures with an absolute XPath that pins the parent-child relationship: the
   Response signature MUST be `/samlp:Response/ds:Signature` (a direct child, not an arbitrary
   descendant), and the Assertion signature MUST be `/samlp:Response/saml:Assertion/ds:Signature` (or
   a direct child of the decrypted Assertion). Namespace prefixes are resolved through registered,
   fixed namespace URIs and never through the literal prefixes declared in the document.
3. Each verified node MUST have **exactly one** direct `ds:Signature` child (zero with the
   corresponding switch set to true rejects; more than one rejects).
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
2. Canonicalize `ds:SignedInfo` with exclusive C14N and verify `ds:SignatureValue` with the
   certificate's public key (`crypto.subtle.verify`, RSASSA-PKCS1-v1_5 + SHA-256 and so on). Failure
   rejects.
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
2. Decrypt `xenc:EncryptedKey`: the SP private key (the connection-level SP decryption private key,
   which may or may not be the same as the SP signing private key, stored encrypted in the CertStore,
   see section 1) decrypts the symmetric session key (AES-128/256) using RSA-OAEP
   (`crypto.subtle.decrypt`, `RSA-OAEP` with SHA-1 or SHA-256 as declared in
   `xenc:EncryptionMethod`). An algorithm outside the allowlist rejects.
3. Use the session key to decrypt `xenc:CipherValue` (AES-GCM or AES-CBC as declared), producing the
   plaintext Assertion XML bytes.
4. Run the plaintext Assertion back through the 9.1 safety pre-checks and 9.2 schema validation, then
   parse it into a DOM.
5. **The decrypted Assertion is held to the same signing requirement** (when
   `want_assertions_signed=true`): run the plaintext Assertion through 9.3 to 9.5, where the signature
   node is the direct `ds:Signature` child of the plaintext Assertion and the referenced ID is unique
   within the plaintext Assertion document. The combination of **signing the Response only, not the
   Assertion, plus EncryptedAssertion** is rejected by default (an attacker could swap the inner
   payload), unless the connection explicitly sets `want_assertions_signed=false` (not recommended,
   and audited).
6. Ordering: **decrypt first, then verify** (decrypt-then-verify), because the signature is invisible
   inside the ciphertext. However, the SP private key used for decryption and the IdP public key used
   for verification are two separate keys: a successful decryption does not imply trust, and signature
   verification is the trust anchor.

### 9.7 Assertion semantic validation (after signature verification passes)

Validate the verified Assertion in order; any failure returns per 9.8:

1. `saml:Issuer` equals the IdP EntityID configured on the connection (exact string match).
2. `saml:Conditions/@NotBefore` <= now < `@NotOnOrAfter`, using the connection's
   `saml_clock_skew_ms` tolerance (default +-3 minutes, maximum +-5 minutes;
   `NotOnOrAfter` is an exclusive upper bound).
3. `saml:Conditions/saml:AudienceRestriction/saml:Audience` contains this SP's EntityID (the SP
   EntityID corresponding to our ACS, taken from TenantContext plus the connection).
4. `saml:Subject/saml:SubjectConfirmation/saml:SubjectConfirmationData` MUST carry a non-empty
   `@Recipient` and a syntactically valid `@NotOnOrAfter`. Missing, blank, or malformed values fail
   closed. `@Recipient` equals our ACS URL exactly and `@NotOnOrAfter` has not passed, using the same
   connection clock-skew tolerance. `@InResponseTo` (in the SP-initiated case) equals an AuthnRequest
   ID that we issued and have not consumed (stored in a Durable Object, single use, replay defense).
   In the IdP-initiated case that attribute MUST be absent, and its presence rejects (confusion
   defense).
5. A login Assertion MUST contain exactly one `saml:AuthnStatement`. Its `@AuthnInstant` is required
   and MUST be a valid date-time. It MUST NOT be later than `now + saml_clock_skew_ms`, and it MUST
   NOT predate the signed Assertion freshness window
   (`Conditions/@NotBefore - saml_clock_skew_ms`). Missing, duplicate, malformed, future, or stale
   authentication evidence fails closed.
6. `samlp:Response/samlp:Status/samlp:StatusCode/@Value` equals
   `urn:oasis:names:tc:SAML:2.0:status:Success`, otherwise handle it as an IdP-reported error (403).
7. Replay defense: record `Assertion/@ID` in the consumed set (a Durable Object, with TTL =
   `NotOnOrAfter` plus the skew window); a repeat rejects.
8. Extract the NameID (the primary key idp_id, see section 1) and the mapped attributes (email,
   firstName, lastName, groups) and enter JIT provisioning (section 4).

### 9.8 ACS endpoint error branches (HTTP status mapping)

Error responses uniformly render the hosted error page (never leaking internal detail to the browser)
while writing an audit entry plus a structured log. Status codes:

| Branch                              | Condition                                                                                                             | HTTP | Internal error code                      | Notes                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------- | ------------------------------------------------ |
| Malformed request                   | SAMLResponse missing, base64 decode failure, XML not well-formed, or a DTD pre-check hit                              | 400  | `malformed_request` / `malformed_xml`    | Never reaches signature verification             |
| Schema validation failure           | XSD or the structural allowlist did not pass                                                                          | 400  | `schema_invalid`                         | Blocks the XSW injection point                   |
| Signature missing                   | The corresponding want_*_signed is true but there is no signature node                                                | 401  | `signature_required`                     |                                                  |
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

Success: establish the session and 302 to the RelayState (validated against this tenant's allowlist of
return URLs; a non-allowlisted target falls back to the default post-sign-in page).

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
- `md:SPSSODescriptor/@AuthnRequestsSigned` (whether we sign the AuthnRequest, matching the
  connection's SP signing switch) and `@WantAssertionsSigned` (= want_assertions_signed).
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

  if validation(staged) fails uniqueness (userName/email):
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
- An unrecognized `op` or a malformed body returns `invalidSyntax`; a path syntax error or a path
  pointing at a nonexistent attribute definition returns `invalidPath`; a filtered path with no match
  under replace and certain other scenarios returns `noTarget`; a wrong value type or a missing
  required value returns `invalidValue`; modifying something readOnly (such as `id` or `meta`) returns
  `mutability`.
- Case sensitivity: SCIM attribute names are caseExact=false (with specific exceptions), and the `op`
  keyword is case-insensitive.

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
1. [sync] Validate and parse the PATCH, locating active=false.
2. [sync] staged.active = false; staged.status = "deactivated".
3. [sync] Persist User.status=deactivated (D1, with the tenant_id + directory_id isolation filter).
         Synchronous persistence guarantees later token validation sees the latest state.
4. [sync] revokeAllSessions(user_id):
           - Call the per-user session revocation Durable Object (see chapter 05 and the cloudflare-bindings rule)
             to clear that user's active session_id set. DO memory updates first (effective within the 60s JWT window).
           - Mark D1 sessions.status=revoked (persisted to D1 asynchronously; the Durable Object is already the source of truth).
           - Revoke every refresh token family for that user (effective immediately).
5. [sync] Return 200 (or 204 with Prefer: return=minimal), with active=false in the body.
6. [async] emitWebhook("user.deactivated", {user_id, directory_id, org_id}):
           delivered through Queues, without blocking the SCIM response (exponential backoff, 5 attempts, dead letter to D1).
7. [async] Audit: append-only write of the deprovisioning event (Queues -> the audit consumer).
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

Mapping (see attribute mapping in section 6): `userName` maps to the primary sign-in identifier;
`emails[primary].value` maps to email; `name.givenName` and `name.familyName` map to first and last
name; `enterprise.department` and `title` map to custom_attributes; `active` maps to User.status; and
`externalId` links to directory_user_id.

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

`displayName` is the key for the group-to-role mapping (see section 6: a displayName change updates
the role mapping in step); `members[].value` maps to DirectoryUser.id (an unknown member goes to
pending, see 10.1.1). Every Users and Groups query goes through the Drizzle tenant query layer, which
injects `WHERE tenant_id = ? AND directory_id = ?` (see the tenant-isolation rule), so cross-directory
and cross-tenant access returns 404 without leaking existence.
