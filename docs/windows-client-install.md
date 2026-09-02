# Windows client installation contract

The Windows client is installed silently and runs as a `LocalSystem` service. The installer receives the server location and the shared API key:

```powershell
NemesysClientSetup.exe /quiet /server "https://nemesys.example.com" /port 5187 /apiKey "<one-time-key>"
```

The source implementation is in `clients/windows-service`. Publish it on a Windows build runner with the .NET 8 SDK to produce the self-contained EXE.

## Installer responsibilities

- Register and start the service under `LocalSystem`.
- Identify the machine using its Windows hostname/computer name.
- Store the API key using Windows-protected storage (DPAPI), never as a reusable plaintext value.
- Keep the server hostname/endpoint in the client configuration file as plain text so the service can resolve the control plane.
- Treat the API key returned by rotation as one-time delivery material; the server does not provide a read-back endpoint.
- Write the initial sync interval and endpoint, then refresh the effective sync configuration at runtime without restarting the service.
- Enroll or refresh the hostname registration before requesting policies.
- Execute a configured silent EXE install command after the warning and close window when a version check is out of policy.

## Administrator access

The control center is protected by a username/password session. Set `NEMESYS_ADMIN_USERNAME`, `NEMESYS_ADMIN_PASSWORD`, and `SESSION_SECRET` in the server environment before first production startup. The Settings page can replace the bootstrap password after login.

## Runtime sync contract

Each sync response supplies:

- the current policy set, including all EXE and INI checks;
- each application's server-controlled Update Mode and close timeout;
- the normal close-on-start timeout; and
- the effective close-on-start timeout for the current mode.

When a policy's Update Mode is active, the client uses that application's shortened timeout and coordinates the interactive user-session companion for warnings/countdowns and process closure across Windows sessions. Multiple EXE checks in one policy are supervised and closed together.

## Rotation warning

Rotating the shared API key invalidates the previous key. Existing clients need an explicit reconfiguration/rollover path; until that is implemented, use the one-time installation command for new clients and plan a controlled fleet rollover for existing ones.