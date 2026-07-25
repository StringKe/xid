/// XID Flutter SDK
///
/// OIDC Authorization Code + PKCE S256, Hosted Auth, secure token storage.
/// Does NOT implement: implicit flow, password grant, client secret storage,
/// SAML, SCIM, or Management API business flows.
library;

export 'src/xid_client.dart' show XidClient;
export 'src/xid_options.dart' show XidOptions;
export 'src/session.dart' show XidSession, XidUser, XidOrganization;
export 'src/token_storage.dart'
    show TokenStorageAdapter, TokenStorageNamespace, SecureStorageAdapter;
export 'src/errors.dart'
    show
        XidException,
        XidAuthException,
        XidNetworkException,
        XidConfigException;
