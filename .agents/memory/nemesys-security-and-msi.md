---
name: Nemesys security and MSI
description: Deployment constraints for encrypted directory/PKI settings and the Windows installer packaging path.
---

LDAP bind passwords, PKI private keys, and the intentionally recoverable client API key are encrypted at rest with a key derived from `SESSION_SECRET`. Changing that secret without re-entering the protected values makes them undecryptable.

**Why:** The Kubernetes deployment is stateless and PostgreSQL is shared, so protected settings must survive pod replacement without storing plaintext secrets in the database.

**How to apply:** Preserve `SESSION_SECRET` across replicas and deployments; treat secret rotation as a coordinated reconfiguration of LDAP and SSL settings.

The client MSI wraps the already self-contained Windows EXE installer and is built with WiX plus the .NET 8 SDK on Windows. The Linux workspace cannot reliably produce or validate the Windows MSI binary.

**Why:** The client targets `net8.0-windows`/`win-x64`, and the MSI packaging toolchain is Windows-oriented.

**How to apply:** Run the documented PowerShell build on a Windows runner after publishing the client; keep the MSI source and silent-property contract in source control, not generated binaries or API keys.

MSI releases keep one stable UpgradeCode, generate a new ProductCode per package, and remove related products before installing the replacement service. Release versions use increasing three-field Windows Installer versions.

**Why:** Windows Installer correlates releases through the UpgradeCode and version rules; inconsistent identities or non-increasing versions can leave multiple registrations competing for the same Windows service.

**How to apply:** Require an explicit `major.minor.build` for every MSI build. Do not rotate the UpgradeCode; increment release versions, and permit same-version major upgrades only as recovery for already duplicated installations.

Kubernetes deployments follow the Change Manager pattern: the web Service exposes ports 80 and 443 directly, console Nginx terminates TLS, and the API remains on Pod-local HTTP. Windows client installs default to HTTPS/443 without requiring a port argument.

**Why:** This environment exposes application Services directly rather than using Kubernetes Ingress. The console must remain reachable on 443 while Nginx proxies API traffic to the HTTP API sidecar.

**How to apply:** Keep ports 80/443 on the web Service, persist certificate files on the shared cert volume, let console uploads refresh those files, and never switch the Pod-local API listener to HTTPS.

Windows clients require an absolute HTTPS control-plane endpoint and use the Local Computer certificate trust store. Expired, untrusted, and hostname-mismatched certificates are rejected.

**Why:** Client synchronization and future LocalSystem OTA downloads require authenticated transport; bypassing TLS validation exposes the shared API key and policy channel.

**How to apply:** Use a publicly trusted certificate or install the private CA in every managed machine's Local Computer trusted roots. OTA artifacts must still use signed manifests, SHA-256 verification, and Authenticode validation.
