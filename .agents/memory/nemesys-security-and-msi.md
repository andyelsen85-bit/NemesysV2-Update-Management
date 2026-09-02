---
name: Nemesys security and MSI
description: Deployment constraints for encrypted directory/PKI settings and the Windows installer packaging path.
---

LDAP bind passwords, PKI private keys, and the intentionally recoverable client API key are encrypted at rest with a key derived from `SESSION_SECRET`. Changing that secret without re-entering the protected values makes them undecryptable.

**Why:** The Kubernetes deployment is stateless and PostgreSQL is shared, so protected settings must survive pod replacement without storing plaintext secrets in the database.

**How to apply:** Preserve `SESSION_SECRET` across replicas and deployments; treat secret rotation as a coordinated reconfiguration of LDAP and SSL settings.

The client MSI wraps the already self-contained Windows EXE installer and is built with WiX v4 plus the .NET 8 SDK on Windows. The Linux workspace cannot produce or validate the Windows MSI binary.

**Why:** The client targets `net8.0-windows`/`win-x64`, and the MSI packaging toolchain is Windows-oriented.

**How to apply:** Run the documented PowerShell build on a Windows runner after publishing the client; keep the MSI source and silent-property contract in source control, not generated binaries or API keys.

Kubernetes deployments terminate public TLS at the Ingress on standard port 443. The console Nginx and API communicate over internal HTTP, and Windows client installs default to HTTPS/443 without requiring a port argument.

**Why:** Enabling the API runtime’s database-backed TLS certificate behind the HTTP Nginx proxy changes the API listener protocol and breaks proxy traffic. The Ingress TLS Secret is the correct Kubernetes certificate boundary.

**How to apply:** Put the certificate in the `nemesys-tls` Kubernetes Secret, keep the API on its internal HTTP port, and do not enable the console’s direct-runtime certificate mode for Kubernetes deployments.