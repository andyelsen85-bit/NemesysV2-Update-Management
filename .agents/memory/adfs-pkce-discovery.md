---
name: AD FS PKCE discovery
description: Interoperability rule for S256 PKCE and AD FS discovery metadata.
---

Always use S256 PKCE for AD FS authorization requests, but do not require `code_challenge_methods_supported` to advertise S256.

**Why:** Some AD FS deployments support and enforce S256 while omitting this optional discovery metadata field. Rejecting the provider based on the omission prevents otherwise valid sign-in.

**How to apply:** Generate and send the verifier, S256 challenge, and `code_challenge_method=S256` on every authorization request; let the provider reject unsupported methods.

Confirmed working against the target AD FS deployment on 2026-09-14.