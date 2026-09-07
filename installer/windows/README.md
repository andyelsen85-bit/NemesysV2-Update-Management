# NemesysV2 Client MSI

This is a WiX v4 x64 MSI wrapper around the self-contained `NemesysV2.Client.exe`.
The MSI installs per-machine and invokes the same elevated silent installer used
by the EXE, which encrypts the shared API key with machine-scoped Windows DPAPI,
writes the clear-text server endpoint, registers the LocalSystem service, and
registers the user-session countdown companion.

The GitHub Actions workflow at `.github/workflows/build-msi.yml` builds this
project on `windows-latest`, uploads the MSI as an Actions artifact, and
attaches it to `v*` GitHub releases. No MSI compilation is required in the
Linux development workspace.

The MSI owns the `NemesysV2Client` service lifecycle through Windows Installer:
it stops the service before file changes, preserves ProgramData during
upgrades, and recreates/restarts the service after an upgrade. True uninstall
stops and removes the service and `C:\ProgramData\NemesysV2` before MSI removes
the executable and installation directory. Standalone EXE installations can
use the elevated `/uninstall` command documented in the client README.

Build on a Windows runner with the .NET 8 SDK:

```powershell
.\installer\windows\build-msi.ps1 -Version 1.0.1
```

## Upgrade identity and versioning

All NemesysV2 Client packages use one stable `UpgradeCode`, identifying them as
members of the same upgrade family. Each MSI build generates a new
`ProductCode`. During an upgrade, Windows Installer removes the related older
package before installing the replacement service.

Always supply an increasing three-field version (`major.minor.build`) for a
release. The build rejects missing, four-field, non-numeric, and out-of-range
versions. Rebuilding the same version is supported for recovery, but normal
client releases should still increment the version so Windows can reject
downgrades reliably.

Artifacts from untagged `main` builds use `0.0.<workflow-run>` test versions.
Use a monotonically increasing `v<major>.<minor>.<build>` tag for an MSI that
will be distributed through SCCM.

For an unattended deployment, pass MSI properties:

```powershell
msiexec /i NemesysV2.Client.msi /qn NEMESYS_SERVER="https://updates.example.local" NEMESYS_API_KEY="..." /l*v nemesys-msi.log
```

`NEMESYS_SERVER` must be an absolute HTTPS URL whose certificate is valid for
the hostname and chains to a root trusted by the Windows Local Computer
account.

The API key is intentionally accepted only through an explicit install
property and is marked hidden in the MSI authoring. Do not store it in source
control or deployment manifests. Existing EXE silent installation remains
available for environments that do not build MSI packages.
