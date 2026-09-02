# NemesysV2 Windows client

This project targets `net8.0-windows` and publishes a self-contained `win-x64` EXE. Build and publish it on a Windows build runner with the .NET 8 SDK:

```powershell
dotnet publish .\NemesysV2.Client.csproj -c Release
```

Run the installer elevated:

```powershell
NemesysV2.Client.exe /quiet /server "https://nemesys.example.com" /port 5187 /apiKey "<one-time-key>"
```

The installer:

- stores the API key using machine-scoped DPAPI;
- leaves the server endpoint and hostname in clear text;
- registers the service as `LocalSystem`;
- creates the per-user session companion at logon; and
- starts the service.

The service enrolls by `X-Nemesys-Hostname`, polls the authenticated sync endpoint, evaluates EXE file versions and INI section/key/value checks, sends audit reports, and applies the server’s current Update Mode timeout without restarting. It uses process enumeration and `Kill(entireProcessTree: true)` under `LocalSystem` so managed processes can be closed across Windows sessions.