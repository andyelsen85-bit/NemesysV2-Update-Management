# NemesysV2 Windows client

This project targets `net8.0-windows` and publishes a self-contained `win-x64` EXE. Build and publish it on a Windows build runner with the .NET 8 SDK:

```powershell
dotnet publish .\NemesysV2.Client.csproj -c Release
```

Run the installer elevated:

```powershell
NemesysV2.Client.exe /quiet /server "https://nemesys.example.com" /apiKey "<one-time-key>"
```

`/server` must include the `http://` or `https://` scheme. The client appends
`/api` and defaults to standard HTTPS port `443`. `/port` remains available
only as an optional compatibility override.

The Windows service intentionally does not validate the server certificate.
This allows synchronization with self-signed, private-CA, expired, or
hostname-mismatched certificates. Protect the connection with a trusted
network path and keep the API key confidential.

The installer:

- stores the API key using machine-scoped DPAPI;
- leaves the server endpoint and hostname in clear text;
- registers the service as `LocalSystem`;
- creates the per-user session companion at logon; and
- starts the service.

The service enrolls by `X-Nemesys-Hostname`, polls the authenticated sync endpoint, evaluates EXE file versions and INI section/key/value checks, sends audit reports, and applies each application's Update Mode timeout without restarting. It uses process enumeration and `Kill(entireProcessTree: true)` under `LocalSystem` so managed processes can be closed across Windows sessions.

## Runtime logs

The service writes a daily log to:

```text
C:\ProgramData\NemesysV2\logs\client-YYYYMMDD.log
```

Synchronization failures are also written to the Windows Application Event Log
under the `NemesysV2.Client` source. The service retries failed synchronization
every 30 seconds.

An x64 MSI wrapper is available under `installer/windows` and uses the same
DPAPI-backed silent installation flow. Build it on a Windows runner with
`build-msi.ps1`.