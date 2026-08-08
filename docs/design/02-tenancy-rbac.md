# 02 - Multi-Tenancy, Organization Model, RBAC

> Chinese version: [`docs/zh-Hans/design/02-tenancy-rbac.md`](../zh-Hans/design/02-tenancy-rbac.md)

## 1. Hierarchy model

```
Instance (platform operations layer, the IAM operator view, can manage across every org)
  -> Organization (tenant/customer layer, the unit of data isolation, may override instance-level policy: MFA/password/sign-in flow)
       -> Project (role definition and authorization aggregation; roles belong to a Project rather than a single App, so they stay consistent across Apps)
            -> Application (OIDC/SAML client, bound to a Project, inheriting that Project's role set)
       -> Project Grant (cross-organization authorization: org A's Project is granted to org B's users)
```

This mirrors Zitadel's four layers. By comparison, Auth0, Clerk, and WorkOS mostly use a single flat
Organization level with no Project layer.

### OrgUnit (in-org business structure)

An OrgUnit is a hierarchical node (department/team) inside one Organization. It is pure business
structure and carries no tenant-boundary semantics: it never participates in TenantContext
resolution, issuer or RPID selection, and never appears in token claims. This is the semantic line
against SubOrg -- a SubOrg is a tenant boundary (its own slug domain, branding, policy, and
enrollment), while an OrgUnit is only an organizational placement plus an approval-routing data
source.

- An OrgUnit belongs to exactly one Organization (top-level or sub-org, referenced by `org_id`);
  `tenant_id` remains the top-level Organization id, so tenant isolation injection is unchanged.
- The tree combines adjacency (`parent_unit_id`) with a materialized path (`path = parent.path +
  '/' + id`, root `/<id>`, including the node itself), so subtree and ancestor queries are prefix
  scans. Depth is capped at 8 (root = 1), enforced in the application layer -- the same strategy as
  the SubOrg depth limit.
- Tree consistency (path generation, depth checks, subtree moves) is centralized in
  `packages/db/src/org-units.ts` behind transactions; the tables carry no foreign keys, matching the
  existing schema style.
- The Organization layer stays flat with one level of SubOrg; OrgUnit does not relax that rule and
  SubOrg nesting is unchanged.

### Design decisions

- An Organization supports one level of sub-organization (Team/SubOrg) and no deeper nesting, because
  ReBAC complexity is high and one level covers 99% of use cases
- A Project acts as a role namespace: Apps under the same Project share the roles claim, which avoids
  reconfiguring roles for every App
- Project Grant: org A's Project can be granted to org B's users without migrating users across orgs

### Data model

The core entities are Instance, Organization, Project, Application, and ProjectGrant (see chapter
08): a four-level ownership chain, where an Organization may have one level of parent/child
relationship. OrgUnit and OrgUnitMember (see chapter 08 sections 10.2b and 10.2c) model the in-org
business tree described above.

### Self-service top-level Tenant onboarding

- Guest sign-in and credential sign-up with `intent=sign-up` both route to the same create
  Organization flow. Only a provisional user with `is_new_user = true` and no Membership may use
  it.
- This product onboarding intent is distinct from an RP asking the OIDC SDK to show registration.
  The SDK sends `xid_intent=sign-up`; `/authorize` maps it to the internal Hosted Auth
  `application-sign-up` intent after validating `client_id`. That flow creates the end user and a
  default member Membership inside the Application owner's existing top-level Tenant, then resumes
  the stashed authorization request. It never creates or migrates a top-level Tenant and never
  enters `/create-organization`.
- Self-service creation makes a new isolation root, not a child of the resolver's provisional
  Organization. Its invariant is `id = tenant_id = new_organization_id` and
  `parent_org_id = null`. Child Organization creation remains an explicit operation with
  `parent_org_id` set and the parent's top-level `tenant_id`.
- A top-level Organization slug is unique within its Instance because it participates in host
  resolution. Tenant-local uniqueness alone is insufficient.
- Management API child creation therefore requires an explicit `parent_org_id` equal to the current
  active top-level Organization. It never infers a parent, never reparents a deleted slug, and never
  accepts a child as a parent. Top-level suspend/delete/restore remains an Instance Manager
  operation on the separate platform path.
- The creation transaction migrates the provisional user's user-owned rows and sessions to the new
  Tenant, creates one active owner Membership, and selects that Organization for every migrated
  session. The session id and opaque cookie remain stable, and the Instance root resolver resolves
  the new TenantContext from its refresh token hash. It does not create a `manager_assignment`;
  platform management remains the existing ManagerAssignment model.
- The owner may read the new Tenant before Email verification, but organization and platform
  business mutations require a verified primary Email. `GET`/`HEAD`/`OPTIONS` are reads.
  Onboarding creation, active Organization switching, sign-out, Email verification and resend, and
  account-security operations are exempt from the mutation gate.
- Guest Email remains pending until it is verified inside the new Tenant and does not reserve a
  `user_emails` value during creation. Email uniqueness is Tenant-local, so the same Email in
  another Tenant stays an independent user. This flow does not merge users across Tenants.
- Invitation acceptance, enterprise JIT, SCIM provisioning, and ordinary sign-in retain their
  existing membership behavior and never enter this self-service path implicitly.

## 2. Organization membership management

### Four sources of membership

- Manual invitation by email: an administrator supplies an email address and a role, which generates
  an invitation token valid for 24-72 hours in the pending state
- Link invitation: a reusable or single-use link, limited by use count and expiry
- Automatic domain-based assignment: the org binds and verifies an email domain (DNS TXT), and
  matching users are added automatically or prompted at sign-up (enrollment mode:
  `automatic` | `invite_required`)
- Directory Sync / SCIM: the enterprise IdP pushes users and groups (see chapter 04)

### Membership state machine

```
invited -> pending -> active
                   -> inactive (administrator deactivation / SCIM deprovision)
pending -> expired
```

### Design decisions

- Invitation tokens are stored in the database (not as JWTs) so they can be revoked, and a bulk
  invitation API is supported
- Organization Membership has exactly three fixed roles: `owner`, `admin`, and `member`. The shared
  `ORGANIZATION_MEMBERSHIP_ROLES` contract drives Worker validation, DB types, SDK session shapes,
  and Console choices. `viewer` is a Project business-role example, not an Organization Membership
  role.
- Owner assignment is a human-principal privilege boundary. A Management API key cannot create,
  promote, restore, or reactivate an `owner`; an owner invitation requires an authenticated
  Organization `owner` or its exact `org_manager`. Demoting, deactivating, or deleting an active
  owner is allowed only when another active owner backed by an active user remains in the same
  Organization. The replacement-owner check and mutation execute in one conditional D1 statement
  so concurrent changes cannot remove the last owner.
- An invitation token carries a versioned, encoded Tenant locator so an anonymous Instance-root
  request can select one candidate Tenant without a global token lookup. The database stores the
  SHA-256 hash of the complete opaque token, including the locator. The locator is never
  authorization: preview and acceptance must find that complete hash through the selected
  Tenant-scoped query layer. Changing the locator therefore invalidates the token.
- External collaborators (guests) are users whose email domain does not belong to the org's verified
  domains. They are flagged separately and can be capped (mirroring WorkOS's domain-managed versus
  domain-guest distinction)
- Seat management: one seat is one distinct user with any active membership across the complete
  Tenant, including child Organizations. Multiple memberships for the same user consume one seat.
  `organization_quotas(seats)` is authoritative; the root `organizations.seat_limit` is a
  compatibility mirror and `seat_used` is legacy only. Deprovisioning the user's last active
  membership frees a seat, and re-provisioning restores the historical roles
- SCIM deprovisioning is a soft delete (inactive) rather than a physical delete, which preserves the
  audit trail

### Data model

The core entities are Membership, Invitation, and OrgDomain (see chapter 08): membership and state,
invitations, and organization email domains.

## 3. Roles and permissions (RBAC)

### Platform management layer (Manager Roles, never injected into business tokens)

Four levels, aligned with Zitadel: Instance Manager (across all orgs), Org Manager (a single org),
Project Manager (a single Project), and Project Grant Manager (managing a granted Project).

The current authorization consumers preserve those exact scopes:

- `instance_manager` enters only the separate `/v1/platform/*` management path.
- `org_manager` is equivalent to an Organization owner for the assigned Organization only.
- `project_manager` can manage Role and Permission definitions, ProjectGrants, and UserGrants for the
  assigned Project, but is not promoted to Organization Admin.
- `project_grant_manager` can read its exact active ProjectGrant and the granted Project's Role and
  Permission definitions, and can assign or revoke UserGrants under that Grant. It cannot mutate the
  Project definitions or revoke the ProjectGrant itself.

The same-origin Console and Management API expose the control plane that owns these rows:

- `/v1/projects` provides reversible Project CRUD. Organization owners/admins create Projects;
  exact `project_manager` assignments may read, update, delete, and restore only their Project.
- `/v1/role-permissions` manages the Role-to-Permission mapping. Both targets must be active and
  belong to the same Project, and the ABAC v1 grammar is rejected at the write boundary when invalid.
- `/v1/manager-assignments` provisions, lists, and revokes tenant-scoped `org_manager`,
  `project_manager`, and `project_grant_manager` assignments. Roles and scope types are a fixed
  one-to-one pair, target users and scopes must exist in the current tenant, and a cookie actor
  cannot assign or revoke itself.
- `/v1/platform/manager-assignments` is the separate cookie-only `instance_manager` path. It is
  never mounted through the tenant business API and never accepts a Management API key.

Provisioning a Project or ProjectGrant manager is an Organization-level privilege; holding the same
Project manager role is not delegation authority. There is still one Console product, not a separate
admin application or tenant.

### Business reporting line versus the control plane

`org_units.manager_user_id` and `manager_assignments` are deliberately separate and never share a
namespace:

- `org_units.manager_user_id` is the business reporting line -- who leads a department or team. It
  grants no `/v1` authorization by itself; its only authorization consumer is approver resolution
  for Project access requests (see section 7.5).
- `manager_assignments` is the control plane -- it alone drives Management API authorization through
  the fixed role/scope pairs above.

A department head is therefore not implicitly an Org or Project manager, and revoking a manager
assignment never changes the reporting line.

### Business RBAC (Project/Application layer)

- Role: defined at the Project level with a key, display_name, and optional group -- for example
  admin/editor/viewer
- Permission: an atomic capability in the format `<feature>:<action>` (following Clerk's
  `org:<feature>:<action>`)
- Token injection: inject the permissions array rather than role names, so business services perform
  stateless authorization and role renames do not break anything
- ABAC: a Permission can carry an attribute expression condition (initially org metadata plus user
  metadata, extended to resource attributes later)
- FGA (later): a WorkOS FGA-style resource graph (resource type + relation + policy), where
  resource-level permissions are queried through an API. Initially, RBAC plus simple ABAC covers 80%
  of use cases

### Token injection comparison

| Platform | Field                                                               |
| -------- | ------------------------------------------------------------------- |
| Zitadel  | urn:zitadel:iam:org:project:roles                                   |
| Clerk    | Custom permissions in the session claims                            |
| Auth0    | permissions claim plus org_id/org_name                              |
| WorkOS   | Org-level roles in the JWT; resource-level goes through the FGA API |

XID injects a permissions array into the token. The Project-level role-to-permission mapping lives in
the database and is read and injected by the preAccessToken Action (a built-in platform Action that
users can override). Org-level manager roles and business RBAC are entirely separate and do not share
a namespace.

### Data model

The core entities are Role, Permission, RolePermission, UserGrant, and ManagerAssignment (see
chapter 08).

## 4. B2B versus B2C modes

### B2C

Users belong directly to the platform (the instance), with no org context, no org claim in the token,
no org switcher, and permissions attached directly to the user.

### B2B

- Users belong to an org through membership and can be members of multiple orgs
- Active Organization: the current operating context, which determines the roles and permissions in
  the token. Each browser tab maintains its own active org independently
- Org Switcher: after switching the active org, the token is refreshed silently with the new org
  claims, with no re-authentication required
- Cross-organization membership: the same user can be a member of several orgs with independent roles
  in each
- An application can set `require_org_context=true` to force org selection before access

### Design decisions

Users are platform-level entities, org membership lives in its own table, and cross-org membership is
supported. `active_org_id` lives in the session, and token refresh carries the current org context.

The Session holds `active_org_id`. User is a platform-level entity, and cross-org access is mediated
by Membership (see chapter 08).

## 5. Per-organization configuration

- SSO enforcement: bind a SAML/OIDC connection to the org so that users with a matching email domain
  MUST go through that org's SSO and cannot use password sign-in
- MFA enforcement: the org level overrides the instance default (`required` | `optional` |
  `disabled`), with a method allowlist
- Organization Domains: DNS TXT verification, `enrollment_mode` (`automatic` | `invite_required`), and
  verified domains marking members as managed
- Organization branding: per-org logo, primary color, and sign-in page, applied automatically when
  the authorize request carries an organization parameter
- Organization metadata: public (readable by the frontend) plus private (server and admin only)
- Organization session policy: per-org override of session idle timeout and absolute timeout
  (`session_idle_timeout_min` / `session_absolute_timeout_days`, where null means inherit from the
  instance; instance defaults are idle 4320 minutes (3 days, bounds 5-43200) and absolute 30 days
  (bounds 1-365))
- Organization token policy: per-org override of the access token TTL, hosted session token TTL,
  refresh idle, and refresh absolute lifetimes (a `token_policy` JSON object where each null field
  inherits from the instance; instance defaults are 3600s / 60s / 30d / 7d with bounds 60-86400 /
  30-300 / 1-365 / 1-90)

### Design decisions

The `org_policies` table centralizes every per-org policy override with field-by-field fallback: any
field left null falls back to the instance default, and any field that is set overrides it. Policies
are read from D1 in real time during the sign-in flow and token generation (the added latency is
acceptable). Branding is stored as JSON and rendered per org by the login Worker.

The core entities are OrgPolicy, OrgBranding, OrgMetadata, and SsoConnection (see chapter 08): policy
overrides, branding, metadata, and connection configuration.

## 6. How data isolation surfaces functionally

### Instance Manager (platform operations)

View users, audit records, and usage across every org; suspend, resume, or delete an org; view (but
not modify) org-level configuration; billing seat statistics and quotas; create orgs on a customer's
behalf.

### Org Admin (tenant self-management)

See only this org's users, members, roles, and audit records; manage invitations and role
assignments; configure SSO, MFA, and branding; view this org's Projects and Apps.

### Design decisions

- Every D1 query MUST carry an org_id filter. The Instance Manager uses a separate management path
  and does not reuse the business API
- Audit logs are partitioned by org_id. An org admin queries only their own; the Instance Manager can
  query across orgs
- The platform can set `allow_org_self_service`: when it is off, org admins cannot change SSO or MFA
  policy and the platform must intervene

The core entities are AuditLog (partitioned by org) and OrgQuota (see chapter 08).

## 7. RBAC token injection implementation spec

### 7.1 The preAccessToken Action mechanism

**Type**: an internal Worker hook function. It is not an arbitrary script that users can upload; the
platform registers it and tenants can override it through Application-level configuration. v1 ships
the built-in implementation only, with user overrides as P1.

**Interface signature**:

```typescript
interface PreAccessTokenContext {
  // The user principal that triggered this token issuance
  user: {
    id: string
    public_metadata: Record<string, unknown>
    unsafe_metadata: Record<string, unknown>
  }
  // The active org of the current session; null in B2C scenarios
  org: {
    id: string
    slug: string
    public_metadata: Record<string, unknown>
  } | null
  // The client requesting issuance
  client: {
    id: string
    project_id: string | null
    is_first_party: boolean
  }
  // Token type: access_token or id_token
  token_type: 'access_token' | 'id_token'
  // The RBAC data already resolved, pre-filled by the platform before the Action is called
  rbac: {
    roles: string[]
    permissions: string[]
  }
  // Grant context: populated in the cross-org Project Grant scenario
  grant: {
    grant_id: string
    granted_project_id: string
    granted_by_org_id: string // org A (owner of the Project)
    granted_to_org_id: string // org B (the grantee)
  } | null
}

interface PreAccessTokenResult {
  // Extra claims to merge into the token; IANA reserved claims cannot be overridden
  // Allowed keys: any non-IANA claim (see https://www.iana.org/assignments/jwt/jwt.xhtml)
  // IANA reserved (overriding forbidden): iss sub aud exp nbf iat jti
  // OIDC standard reserved (overriding forbidden): auth_time nonce acr amr azp at_hash c_hash
  extra_claims: Record<string, unknown>
  // Optional override of the injected RBAC result; when absent the platform's computed rbac is used
  rbac_override?: {
    roles?: string[]
    permissions?: string[]
  }
}

type PreAccessTokenHook = (
  ctx: PreAccessTokenContext,
  env: Env, // The Cloudflare Worker Env, carrying the D1/KV/DO bindings
) => Promise<PreAccessTokenResult>
```

**Execution environment**:

- Called synchronously before the token signing step in the `/token` endpoint (not through an
  asynchronous Queue)
- Runs in the same Worker isolate and can access every Cloudflare binding
- 500 ms timeout: a timeout is treated as returning `{ extra_claims: {} }`. Token issuance is not
  interrupted, but a warning entry is written to the AuditLog
- A thrown exception is treated as an internal error: token issuance fails with HTTP 500 and
  `error: server_error`

**Claims merge rules**:

1. The platform computes RBAC first (roles and permissions, see 7.2) and populates `ctx.rbac`
2. The hook is called and returns a `PreAccessTokenResult`
3. `extra_claims` is shallow-merged into the token payload. If a key collides with an IANA or OIDC
   reserved claim, issuance is rejected with `error: invalid_scope` and
   `error_description: forbidden claim key: <key>`
4. If the hook returned `rbac_override`, it replaces the platform's computed result; otherwise the
   platform's `rbac` is used
5. The final token injects the `permissions` claim in the format described in 7.2 (roles do not enter
   the token; see the design decisions in section 3)

**Execution boundaries**:

- Triggered only when issuing an `access_token` or `id_token`. It does not fire again during
  `refresh_token` rotation; the new access token is triggered by the next `/token` request
- The `client_credentials` grant has no user context, so `ctx.user` and `ctx.org` are both null and
  the RBAC portion is skipped
- The `token exchange` grant (impersonation) is called with the impersonated user's context, so
  `ctx.user` is the target user and the audit record captures the actor

### 7.2 Permission resolution algorithm

**Query path**: UserGrant -> Role -> RolePermission -> Permission

```
UserGrant(user_id, project_id, role_id)
  -> Role(id, project_id, key, display_name)
  -> RolePermission(role_id, permission_id, condition_expression?)
       -> Permission(id, project_id, key, description)
```

- A user can hold several UserGrants under the same Project (multiple roles); permissions are the
  deduplicated union across all of those roles
- Permission.key format: `<feature>:<action>`, for example `document:read`, `billing:manage`, and
  `user:delete`

**Live query versus cache**:

Permissions are queried from D1 on every token issuance and are never cached. Reasons:

- An RBAC change (a role's permissions edited, a user's grant revoked) MUST take effect within the
  next token refresh, which defaults to 1 hour. That 1 hour refers to the OAuth access token (3600s
  by default, configurable per application, see chapter 03). The hosted session token is a separate
  layer with a TTL of about 60 seconds (see chapter 05 section 8.1)
- The permission set is small (usually under 20 entries), and a batched D1 query has a P50 under 5 ms,
  so it does not threaten the 200 ms P99 target
- KV caching is deliberately avoided so that revocation is not delayed by a stale cache; a 1-hour
  access token lifetime is already an acceptable propagation window

**Query implementation** (pseudo-SQL; the Drizzle query layer injects tenant_id automatically):

```sql
-- step 1: get every role_id the user holds under the project
SELECT ug.role_id
FROM user_grants ug
WHERE ug.user_id = :user_id
  AND ug.project_id = :project_id
  AND ug.tenant_id = :tenant_id;

-- step 2: get the permissions and conditions for those roles
SELECT p.key, rp.condition_expression
FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE rp.role_id IN (:role_ids)
  AND p.tenant_id = :tenant_id;
```

**ABAC condition evaluation**:

For each `(permission, condition_expression)` pair, call the condition evaluator described in 7.3
with the current `PreAccessTokenContext` as the evaluation context. A null condition means the
permission is granted unconditionally. Permissions whose condition evaluates to false are excluded
from the final set.

**Example token claims format**:

```jsonc
// Access token payload (JWT)
{
  "iss": "https://xid.dev",
  "sub": "user_01HX...",
  "aud": "https://api.acme.com", // determined by the resource parameter
  "exp": 1748000000,
  "iat": 1747996400,
  "jti": "tok_01HX...",
  "scope": "openid profile document:read",
  "client_id": "app_01HX...",
  "org_id": "org_01HX...", // the active org; omitted in B2C
  "org_slug": "acme-corp", // convenient for logs; omitted in B2C
  "permissions": [
    // every permission key that passed its ABAC condition
    "document:read",
    "document:comment",
  ],
  // roles are not injected into the token (design decision: decouple from role renames, so business logic depends only on permissions)
}
```

- The `permissions` claim is an array of strings whose values are Permission.key
- The `org_id` claim holds Organization.id (not the slug; the slug is attached separately as
  `org_slug` for debugging)
- When `permissions` is empty, `"permissions": []` is still injected rather than omitting the key

### 7.3 ABAC condition expression syntax (v1)

v1 supports simple comparisons only, with no nested logic and no resource attributes. The
`condition_expression` is stored as a JSON string in the nullable
`RolePermission.condition_expression` column.

**Evaluation context variables**:

| Variable path                | Type   | Notes                        |
| ---------------------------- | ------ | ---------------------------- |
| `user.public_metadata.<key>` | any    | A user public_metadata field |
| `user.unsafe_metadata.<key>` | any    | A user unsafe_metadata field |
| `org.public_metadata.<key>`  | any    | An org public_metadata field |
| `org.id`                     | string | Active org ID                |
| `org.slug`                   | string | Active org slug              |

**Operators (the complete v1 set; no other operators are supported)**:

| Operator | Semantics                              | Example                                                                             |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `eq`     | Strict equality (===)                  | `{ "op": "eq", "var": "user.public_metadata.plan", "value": "enterprise" }`         |
| `in`     | Value is in the array (Array.includes) | `{ "op": "in", "var": "user.public_metadata.tier", "value": ["gold", "platinum"] }` |
| `not_eq` | Not equal                              | `{ "op": "not_eq", "var": "org.public_metadata.status", "value": "suspended" }`     |
| `not_in` | Not in the array                       | `{ "op": "not_in", "var": "user.public_metadata.region", "value": ["CN", "RU"] }`   |

**Top-level structure of condition_expression** (a single condition or several ANDed conditions):

```jsonc
// Single condition
{
  "op": "eq",
  "var": "user.public_metadata.plan",
  "value": "enterprise"
}

// Multiple conditions ANDed (granted only when every sub-condition is true)
{
  "and": [
    { "op": "eq",  "var": "user.public_metadata.plan", "value": "enterprise" },
    { "op": "not_in", "var": "org.public_metadata.status", "value": ["suspended"] }
  ]
}
```

v1 does not support top-level `or` or `not` composition. When OR semantics are needed, configure the
condition on several separate RolePermission rows; the union produces the same effect.

**Evaluation failure handling**:

- The var path does not exist (for example public_metadata has no such key): the variable value is
  treated as `undefined`
  - `eq` and `in` against undefined evaluate to false, so the permission is not granted
  - `not_eq` and `not_in` against undefined evaluate to true, so the permission is granted
- The condition_expression fails JSON parsing: treated as a configuration error. The permission is not
  granted and an error entry is written to the AuditLog (token issuance is not interrupted)
- An unsupported operator: treated as a configuration error. The permission is not granted and an
  error entry is written to the AuditLog
- An unsupported variable path, empty `and`, extra object key, or non-array `in`/`not_in` operand is
  also a configuration error and fails closed. This is distinct from a supported metadata path whose
  key is absent and therefore resolves to `undefined`.

**Reserved for v2** (not in the first release): top-level `or` and `not` composition; resource
attribute variables `resource.<type>.<attr>`; and the numeric comparisons `gt`, `gte`, `lt`, `lte`.

### 7.4 Project Grant cross-organization token injection rules

**Scenario**: org A owns Project P and grants P to org B through a ProjectGrant. When a user in org B
accesses Application App1, which is bound to Project P, the token claims follow the rules below.

**Preconditions**:

- The ProjectGrant record is
  `{ granted_project_id: P.id, granted_by_org_id: A.id, granted_to_org_id: B.id }`
- User U is a member of org B (Membership) and holds a UserGrant scoped to that ProjectGrant
  (`user_id: U.id, project_id: P.id, granted_via_grant_id: grant_id`)
- App1 is bound to Project P (`application.project_id = P.id`)

**Token claim value rules**:

| Claim            | Value                                                                               | Notes                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`            | The instance issuer, for example `https://xid.dev`                                  | Defaults to the instance issuer; neither the Project's owning org nor the grant org changes the signer                                |
| `sub`            | User U's `user_id`                                                                  | The user principal is unchanged                                                                                                       |
| `org_id`         | org B's ID                                                                          | The user's operating context is org B (the active org), which answers "who is acting"                                                 |
| `granted_org_id` | org A's ID                                                                          | The Project owner; injected only in the Project Grant scenario                                                                        |
| `project_id`     | Project P's ID                                                                      | Injected so the resource server can confirm the authorization scope                                                                   |
| `permissions`    | The permissions of the roles attached to the UserGrant obtained through the Grant   | Same as the ordinary case, using the algorithm in 7.2; when `UserGrant.granted_via_grant_id` is non-null the Grant query path is used |
| `aud`            | The value named by the resource parameter; when unspecified, `aud = App1.client_id` | Same as the ordinary case, determined by the request's resource parameter                                                             |

**Note on the `iss` value**: the hosted default model follows ZITADEL's instance issuer. The issuer
represents the XID instance doing the signing and is fixed to the instance issuer, for example
`https://xid.dev`. It does not change based on the Application's owning org, the ProjectGrant owner
org A, or the consuming org B. A resource server validates `iss` against the instance issuer and uses
`org_id`, `granted_org_id`, `project_id`, and `permissions` to decide the business authorization
boundary.

**Permission query path (Grant scenario)**:

```sql
-- step 1: get the role_id granted to the user through the Grant
SELECT ug.role_id
FROM user_grants ug
WHERE ug.user_id = :user_id
  AND ug.project_id = :project_id
  AND ug.granted_via_grant_id = :grant_id
  AND ug.tenant_id = :tenant_id;  -- tenant_id is org A's tenant

-- step 2: same as step 2 in 7.2
```

Note that tenant_id takes org A's value, because the Role and Permission definitions belong to org A.

**Consent reuse across orgs**:

Consent is not reused. Consent is persisted by `(user_id, client_id, scope_set)` (see chapter 03
section 6). In the Project Grant scenario:

- The first time user U (a member of org B) accesses App1 (an Application belonging to org A), the
  full consent screen MUST be shown if App1 is not first-party
- The consent record's user_id is U's user_id and its client_id is App1.client_id, entirely
  independent of any consent record in org B
- An org B administrator cannot pre-authorize org A's Application on a user's behalf; the user MUST
  consent personally
- Revisiting with the same scope set passes silently through the ordinary logic (a consent record
  already exists for that user_id plus client_id plus scope_set)

**Where UserGrants are managed**:

- `POST /v1/user-grants` and its list/detail/revoke routes accept an API key with
  `user_grants:read` / `user_grants:write`, or a cookie session authorized at the exact Project or
  ProjectGrant scope
- org A's Project Manager and the exact Project Grant Manager can assign UserGrants to org B users
  under the ProjectGrant
- An org B owner or administrator can assign roles under that Grant only to active members of org B.
  The API path is implemented; a dedicated org B ProjectGrant management page in Console is not
  implemented
- UserGrant deletion path: when a ProjectGrant is revoked, every UserGrant under it is invalidated in
  cascade (not physically deleted, but marked with `revoked_at`)

**Coexistence of multiple active orgs and Grants**:

A user can simultaneously be an ordinary member of org B (holding org B UserGrants) and hold a
ProjectGrant (holding org A UserGrants via the Grant). The session's `active_org_id` determines which
path this token takes:

- active_org = org B accessing an org B App -> ordinary RBAC path, no `granted_org_id` claim
- active_org = org B accessing org A's App1 through the Grant -> Grant path, `granted_org_id` injected
- active_org = org A (the user is also an org A member) accessing App1 -> ordinary RBAC path,
  computed from org A's UserGrant

**Error handling**:

- ProjectGrant missing or revoked: `/authorize` returns `error: access_denied` with
  `error_description: project grant revoked or not found`
- The user has no UserGrant under the Grant: same as above, with
  `error_description: user not authorized via grant`
- The ProjectGrant exists but the Application is not under the granted Project:
  `error: unauthorized_client`

### 7.5 Project access policy and AccessRequest

Each Project carries an `access_policy` column (default `open`, opt-in per Project) that governs the
same-Organization authorization branch (`project.org_id === active_org.id`; the cross-org
ProjectGrant path in 7.4 is unaffected):

| policy              | Same-org user without an effective UserGrant          | Self-service entry             |
| ------------------- | ----------------------------------------------------- | ------------------------------ |
| `open`              | Allowed (the pre-existing behavior)                   | None needed                    |
| `restricted`        | Denied (`access_denied`)                              | None; an admin creates the grant directly |
| `approval_required` | Denied with an identifiable error                     | Self-service AccessRequest     |

An "effective UserGrant" is a same-org grant row (`granted_via_grant_id IS NULL`) that is not
revoked and not past `expires_at`; an expired grant is treated as no grant at every check point
(`/authorize` and token issuance alike), which is what makes the JIT window enforceable. Changing
`access_policy` is itself audited (`project.access_policy_changed`); tightening a policy does not
revoke already-issued tokens -- they age out naturally while the grant re-check runs on every token
issuance.

**AccessRequest state machine**:

```
pending --approve--> approved      (writes user_grants in the same transaction)
pending --deny-----> denied        (decision_reason required)
pending --cancel---> cancelled     (the requester only)
pending --expire---> expired       (lazy: pending and created_at older than 14 days)
```

All four outcomes are terminal. Expiry is lazy: a pending request older than 14 days is flipped to
`expired` on read (no cron). At most one pending request per `(user, project)` exists at a time,
backed by a partial unique index.

**Approver resolution** (`resolveAccessRequestApprover`), first hit that is not the requester wins;
a hit equal to the requester is skipped and resolution falls through, because an approver can never
decide their own request:

1. The OrgUnit reporting line: the nearest active `manager_user_id` walking up the ancestor chain
   from the requester's primary unit (`resolveApproverChain`)
2. The exact `project_manager` ManagerAssignment for the Project (earliest `created_at` when
   several exist)
3. The exact `org_manager` ManagerAssignment for the Organization (same tie-break)

When the chain is empty, approve/deny return `no_available_approver`; the documented fallback is an
org manager operating `user_grants` directly through the existing `/v1` Management API. Approval
writes a `user_grants` row carrying `granted_via_request_id` for traceability plus an optional
`expires_at` for just-in-time time-boxed authorization.

**Capability boundaries**:

- Invitation brings a user into the Organization (Membership); AccessRequest grants an existing
  active member access to one Project -- a different layer.
- SCIM provisions users and memberships from the enterprise directory; it is not a Project
  authorization channel and v1 maps no directory group to an OrgUnit or Project role.
- ProjectGrant authorizes users of another Organization cross-org; `access_policy` and AccessRequest
  apply only to the same-org branch and never gate the Grant path.

The wire surface lives in chapter 06 section 7 (Management API) and the `/auth/access-requests` /
`/auth/access-approvals` session endpoints; v1 ships no UI page for either flow.
