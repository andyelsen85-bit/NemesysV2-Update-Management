---
name: API key disclosure auditing
description: Security rule for revealing the shared Windows client API key to administrators.
---

Ordinary settings and page-load requests must never return the plaintext client API key. Every successful response that exposes plaintext—including reveal, generation, or saving—must first append an audit entry with the authenticated session username and timestamp.

**Why:** Administrator access alone should not make secrets passively visible, and every intentional disclosure needs durable accountability.

**How to apply:** Keep plaintext behind an explicit action, send disclosure responses with no-store caching, remove plaintext from UI state when hidden, and provide no console endpoint or action that deletes disclosure history.