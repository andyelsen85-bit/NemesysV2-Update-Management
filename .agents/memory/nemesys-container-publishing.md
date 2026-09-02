---
name: Nemesys container publishing
description: Container build and registry assumptions for Kubernetes deployments.
---

GitHub Actions publishes separate API and console images to GHCR. The workflow emits immutable `sha-*` tags as well as `latest`; Kubernetes should prefer the SHA tag for reproducible rollouts.

**Why:** The existing pnpm workspace excludes several non-host esbuild packages in its lockfile, so the current image pipeline intentionally targets `linux/amd64`.

**How to apply:** Keep the GHCR image owner synchronized with the repository owner when forking, and add an image pull secret to both Deployments if the packages are private.