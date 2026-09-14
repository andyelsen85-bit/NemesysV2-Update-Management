---
name: openid-client token signatures
description: Security requirement for ID-token signature validation with openid-client v6.
---

When using openid-client v6 for OIDC authorization-code processing, explicitly enable non-repudiation checks on every Configuration, including both discovered and manually constructed configurations.

**Why:** The default authorization-code checks validate claims, but this version does not perform ID-token JWS verification through the provider JWKS unless non-repudiation checks are enabled.

**How to apply:** Enable the checks before caching or using each Configuration, and retain expected state, nonce, issuer, audience, expiry, and PKCE validation.