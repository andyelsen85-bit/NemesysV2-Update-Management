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

Build on a Windows runner with the .NET 8 SDK:

```powershell
.\installer\windows\build-msi.ps1 -Version 1.0.0
```

For an unattended deployment, pass MSI properties:

```powershell
msiexec /i NemesysV2.Client.msi /qn NEMESYS_SERVER="https://updates.example.local" NEMESYS_API_KEY="..." /l*v nemesys-msi.log
```

The API key is intentionally accepted only through an explicit install
property and is marked hidden in the MSI authoring. Do not store it in source
control or deployment manifests. Existing EXE silent installation remains
available for environments that do not build MSI packages.