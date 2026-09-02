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
- removes the legacy LocalSystem logon task; and
- starts the service.

The service enrolls by hostname (the reported address is the best available local
IPv4 address), polls the authenticated sync endpoint, evaluates EXE file versions
and INI section/key/value checks, and sends labelled audit summaries for every
configured check. Missing files, unavailable EXE versions, missing INI values, and
unconfigured expected values are explicitly reported.

When a noncompliant application must be closed, the LocalSystem service creates a
service-owned, ACL-protected named pipe and launches a short-lived
`--session-companion` in the active user's `winsta0\default` desktop using the
user session token. The service verifies that the connected companion is an
authenticated user running the installed executable in that session. If no valid
companion can launch, connect, authenticate, or reply, enforcement is skipped;
it never closes the application merely because a warning timed out. A completed
countdown or **Close application now** proceeds, while **Postpone** defers only
when policy allows it.

The GUI companion is built without a console window. Connection and
authentication have a separate bounded deadline; the response deadline begins
only after the warning message is sent and flushed, so it includes the full
configured countdown plus a response grace period.

The service uses process enumeration and `Kill(entireProcessTree: true)` under
`LocalSystem` so managed processes can be closed across Windows sessions after a
valid warning outcome.

## Runtime logs

The service writes a daily log to:

```text
C:\ProgramData\NemesysV2\logs\client-YYYYMMDD.log
```

The log records evaluation/report summaries and warning requests, companion
launch/connection/authentication outcomes, postponements, unavailable companions,
process-close requests, and installation attempts.

Synchronization failures are also written to the Windows Application Event Log
under the `NemesysV2.Client` source. The service retries failed synchronization
every 30 seconds.

An x64 MSI wrapper is available under `installer/windows` and uses the same
DPAPI-backed silent installation flow. Build it on a Windows runner with
`build-msi.ps1`.