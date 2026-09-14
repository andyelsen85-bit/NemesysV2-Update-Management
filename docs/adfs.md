# AD FS OpenID Connect

NemesysV2 supports Microsoft Active Directory Federation Services (AD FS) as an
additional administrator sign-in method. Local administrator credentials and
LDAP sign-in remain available. AD FS authentication uses the OIDC Authorization
Code flow with S256 PKCE; it creates the normal NemesysV2 administrator
session and does not persist an AD FS access token, refresh token, or ID token.

## Supported AD FS capability

The integration targets OIDC 1.0 on AD FS deployments running Windows Server
2016 or later (including 2019 and 2022) that have the OIDC provider enabled
and advertise:

- OIDC discovery metadata (`.well-known/openid-configuration`);
- authorization code flow (`response_type=code`);
- S256 PKCE;
- signed ID tokens, a JWKS endpoint, and issuer/audience metadata.

The server validates discovery, issuer, audience/client ID, token time
validity, JWKS signatures, nonce, state, and the authorization-code exchange.
An AD FS version or configuration that cannot provide OIDC discovery and S256
PKCE is not supported by this integration. The configured issuer and discovery
URL must use HTTPS.

Each login request carries a cryptographically random state, nonce, and PKCE
verifier. State is held in a signed, short-lived HttpOnly cookie and includes
the validated local return target; the callback must match that cookie before
it can create an application session.

## Registering the AD FS application

Create an **Application Group** in AD FS. Register the client according to the
deployment model:

### Public/native application (PKCE)

Use a **native application** (public client) when the NemesysV2 API cannot
keep a client secret. Configure the OIDC client with:

1. The NemesysV2 client ID.
2. The authorization-code flow.
3. S256 PKCE.
4. The exact redirect URI described below.
5. No client secret.

NemesysV2 omits `client_secret` from the token exchange when no secret is
configured. PKCE is required; a public client must not use a copied or
invented secret.

### Server/web application (confidential client)

Use a **server application** when the API is configured with a client secret.
Configure the client ID, exact redirect URI, and secret in AD FS, then enter
the secret in the administrator settings panel. NemesysV2 sends the secret
only during the server-side token exchange. The secret is encrypted at rest
with the existing server-side encryption key derived from `SESSION_SECRET` and
is never returned to the browser or included in logs.

### Redirect URI

Register and configure exactly this callback on the public HTTPS origin:

```text
https://<public-nemesys-host>/api/auth/adfs/callback
```

For example, if the console is publicly reached at
`https://updates.example.com`, the callback is
`https://updates.example.com/api/auth/adfs/callback`. The origin must be the
same public origin users use for the console; do not register the internal
Pod-local API address, an HTTP URL, a URL with credentials, or a URL with a
fragment. The GUI and `ADFS_REDIRECT_URI` accept an explicit absolute HTTPS
URI and AD FS requires an exact match.

## Scopes and claims

Request these scopes:

```text
openid profile email
```

`openid` is mandatory and is added if it was accidentally omitted from a
stored or environment setting. `profile` and `email` are recommended so the
administrator identity has useful display and contact claims.

Do **not** request `user_impersonation`. This application does not call a
separate AD FS-protected Web API on behalf of the administrator;
`user_impersonation` is an API/delegated-permission concept and is not needed
to authenticate a NemesysV2 administrator.

Configure AD FS issuance transform rules (or equivalent claims issuance) to
place these values in the ID token:

| NemesysV2 setting | Recommended claim | Use |
| --- | --- | --- |
| Username/identity claim | `upn` | Matches the pre-provisioned administrator username |
| Email claim | `email` | Fallback administrator match |
| Display-name claim | `name` | Identity display information |
| OIDC subject | `sub` | Stable AD FS identity mapping |

In a typical AD FS rule set, map the directory `userPrincipalName` attribute
to `upn`, `mail` to `email`, and `displayName` to `name`; retain AD FS's stable
OIDC `sub` claim. Use the actual claim names emitted by the rule set in the
NemesysV2 fields when an installation uses different names.

The claim names can be changed in NemesysV2 when an AD FS rule emits different
names. Claims are not copied into logs.

NemesysV2 uses a pre-provisioned, active administrator policy: it does not
grant administrator access merely because an AD FS user authenticated and does
not silently create a new administrator. Resolution first uses an existing
issuer/`sub` identity mapping, then normalized username/UPN, then normalized
email. Matching is case-insensitive. Disabled or inactive accounts are
rejected. Conflicting username and email matches, duplicate matches, and a
mapping to a different account fail safely and require an administrator to
correct the account or mapping.

## Configure NemesysV2

An administrator can configure **Settings → AD FS authentication** in the
console. Enable the provider, enter the issuer, client ID, redirect URI,
scopes, and claim names, and optionally enter a client secret and internal CA
certificate. The sign-in button appears only when AD FS is enabled and
sufficiently configured. Existing local and LDAP options are not removed.

### Environment fallbacks

The following environment variables are deployment fallbacks when the
corresponding database setting has not been stored:

| Variable | Meaning and default |
| --- | --- |
| `ADFS_ENABLED` | `true`/`false`, `1`, or `yes`; defaults to `false` |
| `ADFS_DISPLAY_NAME` | Login button label; defaults to `Sign in with AD FS` |
| `ADFS_ISSUER` | Required HTTPS AD FS issuer/authority URL |
| `ADFS_DISCOVERY_URL` | Optional HTTPS discovery metadata URL; otherwise issuer discovery is used |
| `ADFS_CLIENT_ID` | Required AD FS application/client ID |
| `ADFS_CLIENT_SECRET` | Optional confidential-client secret; omit for public PKCE |
| `ADFS_REDIRECT_URI` | Required exact public HTTPS callback URI |
| `ADFS_SCOPES` | Space-separated scopes; defaults to `openid profile email` |
| `ADFS_USERNAME_CLAIM` | Username claim; defaults to `upn` |
| `ADFS_EMAIL_CLAIM` | Email claim; defaults to `email` |
| `ADFS_DISPLAY_NAME_CLAIM` | Display-name claim; defaults to `name` |
| `ADFS_CA_CERT_PEM` | Optional PEM-encoded internal CA certificate |

Environment values are useful for a first deployment or a recovery fallback;
they are not a replacement for protecting `SESSION_SECRET`. Never put a real
client secret, private key, or certificate chain containing private key
material in a repository or ConfigMap.

### Database precedence and secret semantics

Stored AD FS settings take precedence over environment fallbacks on a
field-by-field basis when a value is present. For the optional secret and CA,
an explicit clear also suppresses the corresponding environment fallback. This
makes it possible to disable or remove an old deployment fallback deliberately;
an unset ordinary field continues to use its environment fallback.

For the optional client secret:

- omitting `clientSecret` when saving means **leave the existing secret
  unchanged**;
- supplying a new non-empty `clientSecret` replaces it and encrypts it before
  storage;
- `clearClientSecret: true` explicitly removes it and selects public-client
  behavior;
- API responses expose only `secretConfigured`, never the secret itself.

The CA certificate follows the same omission/replacement/removal model using
`caCertificatePem` and `clearCaCertificate`, and responses expose only
`caConfigured`. PEM input is validated as a certificate before it is saved.

At startup, NemesysV2 applies an **additive automatic schema migration** for
the AD FS settings and external identity-mapping tables. It preserves
existing authentication records and requires no manual migration command.
Continue taking the normal PostgreSQL backup before a release.

## Internal AD FS CA certificates

If AD FS uses an internal certificate authority, paste the PEM certificate in
the **CA Certificate PEM** field in the AD FS settings panel, or use the
optional `ADFS_CA_CERT_PEM` deployment fallback. The GUI also accepts a PEM
file upload and indicates whether a custom CA is configured; replace or clear
the value when the issuing CA changes.

The certificate must be public CA certificate material, not a private key.
NemesysV2 validates it before saving and extends Node.js's normal trusted root
set with the configured CA. It does not replace public roots, and it never
disables TLS validation. The configured CA is applied to discovery, token
exchange, and JWKS retrieval. If the issuer or CA changes, the OIDC discovery
and JWKS client cache is invalidated. For environment-only deployments,
provide the PEM through the platform's protected environment/secret
management rather than committing it to Git.

## Login, reauthentication, logout, and deep links

After a successful AD FS login, NemesysV2 creates its normal secure,
HttpOnly application session. It also sets the non-sensitive
`nemesys_login_method=adfs` preference cookie for approximately one year.
The preference identifies the last login method; it is not an authentication
credential.

If that application session expires while the preference remains, the console
starts AD FS automatically **once per browser tab**, using tab-scoped storage
to prevent redirect loops. The current local path, query string, and fragment
are returned after authentication. AD FS decides whether its own SSO session
can complete the request; NemesysV2 does not use an insecure hidden iframe.

Explicit logout ends the NemesysV2 session, clears the login preference, and
does not immediately start AD FS again. Local and LDAP sign-in continue to
work, and choosing either clears the AD FS preference.

Protected deep links such as `/changes/123` or
`/requests/456?tab=history` are preserved through the login page and the AD FS
state. Only local application-relative paths are accepted. Absolute URLs,
protocol-relative URLs (`//...`), backslashes, control characters, malformed
encodings, other schemes, and other-origin URLs are rejected and safely fall
back to `/`; an unsigned callback `returnTo` cannot create an open redirect.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Discovery fails or returns 404 | Confirm `ADFS_ISSUER` is the AD FS issuer, the discovery endpoint is reachable from the API Pod, and `ADFS_DISCOVERY_URL` (if set) is the provider's HTTPS `.well-known/openid-configuration` document. |
| TLS/certificate error | Verify the public hostname on the AD FS certificate, install/provide the issuing CA through the GUI or `ADFS_CA_CERT_PEM`, and ensure the PEM is a CA certificate. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| JWKS or signature failure | Confirm the JWKS endpoint in discovery is reachable and that AD FS publishes the signing key used for the ID token. Rotate/refresh AD FS signing keys and retry after the cache is invalidated. |
| Issuer mismatch | The issuer in discovery and the `iss` claim must match the configured issuer after normal trailing-slash normalization. Correct the AD FS issuer or discovery URL rather than weakening validation. |
| Audience/client ID failure | Confirm the NemesysV2 client ID is the registered AD FS application identifier and that the token audience is that ID. |
| Nonce failure | Restart sign-in in the same browser tab. Check that a proxy is not replaying, caching, or rewriting the callback and that cookies are enabled. |
| State or callback validation failure | Use the same HTTPS public origin that started login, keep the short-lived state cookie, and retry within its ten-minute lifetime. Check proxy cookie/host handling. |
| Missing UPN/email/name claims | Review AD FS issuance transform rules and the configured claim-name fields. Ensure `sub`, the configured username or email claim, and the expected display claim are in the signed ID token. |
| “No active administrator account matches” | Pre-provision the administrator, enable the account, and make its username/UPN or email match. Do not create a second account to work around a conflict. |
| Login button is absent | Confirm `enabled`, issuer, client ID, and the exact HTTPS redirect URI are configured. Database settings override environment values, including an explicit clear. |

The API logs a safe reason such as discovery, state, or token validation
failure, but never logs authorization codes, tokens, client secrets, PEM
contents, or full sensitive claims.

## Kubernetes rollout

The test overlay contains commented, non-secret AD FS fallback examples in
[`deploy/kubernetes/overlays/test/api-env.yml`](../deploy/kubernetes/overlays/test/api-env.yml).
Set real values through the cluster's secret/configuration management, or
configure them in the GUI after the API is running. Do not put a real secret
or certificate in Git. `DATABASE_URL` and `SESSION_SECRET` remain Secret
values.

Before applying a release:

1. Back up PostgreSQL; API startup applies the additive AD FS settings and
   identity-mapping migration under the existing startup migration lock.
2. Build the full-stack release and mirror **both the API image and the
   console image** to Nexus. This integration changes both sides of the
   login contract; mirroring only one image can leave incompatible versions.
3. Update the immutable API and console tags in
   `deploy/kubernetes/overlays/test/kustomization.yml`.
4. Apply the overlay and wait for PostgreSQL and Nemesys rollouts:

   ```bash
   kubectl apply -k deploy/kubernetes/overlays/test
   kubectl -n nemesys rollout status deployment/pg-deployment
   kubectl -n nemesys rollout status deployment/nemesys-deployment
   ```

5. Verify that the callback uses the externally reachable TLS hostname, not
   the internal `api` Service, and test both AD FS and a preserved local/LDAP
   login before declaring the rollout complete.

The API must be able to reach AD FS discovery, token, and JWKS endpoints from
inside the Pod. If AD FS is only reachable through cluster egress policy,
proxy, or internal DNS, allow those routes before enabling the provider.