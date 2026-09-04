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

The saved `client.json` contains only the machine-DPAPI-encrypted API key.
Computed clear-text values are excluded from serialization. Loading a
configuration created by an older version rewrites it without the legacy
clear-text `apiKey` and computed `apiBase` fields.

To remove a standalone EXE installation from an elevated prompt:

```powershell
NemesysV2.Client.exe /uninstall
```

This stops and deletes the `NemesysV2Client` service, removes the obsolete
user-session scheduled task if present, and deletes
`C:\ProgramData\NemesysV2`.

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
IPv4 address), refreshes the authenticated sync endpoint, and scans the configured
policies and running processes on its jittered polling cadence. It evaluates EXE file
versions and INI section/key/value checks and sends labelled audit summaries for
every configured check. Missing files, unavailable EXE versions, missing INI
values, and unconfigured expected values are explicitly reported. If the config
endpoint is temporarily unavailable after a successful download, the service
continues those local scans from its cached configuration. API operations have a
bounded timeout, and each scan delay is measured from the previous scan start so
network time does not extend the cadence. Audit reports are anti-flooded: they
are sent on a configuration or compliance-state change, and the reported state
is recorded only after a successful POST.

Polling is randomly jittered around five minutes under normal operation and
around 30 seconds while at least one enabled received policy is in Update Mode.
The effective interval fields retained in the sync payload are accepted for
compatibility but do not override that client behavior.

When a policy is noncompliant, the service first checks whether any configured
supervised, legacy, or version-check executable is currently running. If none is
running, it skips the user warning and process closure, runs any applicable
silent update command, and checks again on a later poll. When a noncompliant
application is running and must be closed, the LocalSystem service creates a
service-owned, ACL-protected named pipe and launches a short-lived
`--session-companion` in the active user's `winsta0\default` desktop using the
user session token. The service verifies that the connected companion is an
authenticated user running the installed executable in that session. If no valid
companion can launch, connect, authenticate, or reply, enforcement is skipped;
it never closes the application merely because a warning timed out. A completed
countdown or **Close application now** proceeds, while **Postpone** defers only
when policy allows it.

Running-process detection uses OR behavior: any one configured executable is
enough to trigger the warning for a noncompliant policy. The configured EXEs do
not all need to be running simultaneously. After an approved warning outcome,
all configured managed processes that are currently running are closed.

The GUI companion is built without a console window. Connection and
authentication have a separate bounded deadline; the response deadline begins
only after the warning message is sent and flushed, so it includes the full
configured countdown plus a response grace period.

The service uses process enumeration and `Kill(entireProcessTree: true)` under
`LocalSystem` so managed processes can be closed across Windows sessions after a
valid warning outcome. Enforcement is scheduled independently per policy, so a
warning countdown, close operation, or installer never delays policy scanning.
Only one enforcement/install task can be active for a policy; started installer
commands are tracked through exit and their exit code is logged. Process
enumeration continues every scan even during an enforcement cooldown, so a
process restarted after closure is detected on the next 30-second scan.
To avoid repeated prompts or launch attempts, Postpone and completed install
attempts use a five-minute enforcement cooldown, while unavailable companions,
unknown process state, and close failures use one minute. Cooldowns are cleared
when the policy becomes compliant or its configuration changes. If process
enumeration is unknown, the service fails safe and does not warn, close, or
install.

Each policy supplies its own `normalCloseTimeoutSeconds` (default 30 seconds)
and `updateModeCloseTimeoutSeconds` (default 8 seconds); warnings use the
appropriate timeout directly rather than a global close-timeout setting.

Policies can optionally set `launchOnExitUpdateMode`, a full
`launchExecutablePath`, optional `launchArguments`, and an
`updateModeCycleId`. The service launches only after it has itself observed the
same enabled policy/cycle move from Update Mode to normal mode. It does not
launch for an initial normal-mode policy, after a service restart with no
recorded active cycle, or for disabled/deleted/compliant policies. Before a
launch it rechecks compliance and checks the selected active user session
(console session preferred, otherwise lowest active session) for that exact
executable. No active session leaves the cycle pending. The full configured
path and arguments are passed directly to `CreateProcessAsUser`, never through
`cmd.exe`.

While an eligible launch-on-exit cycle is pending, attempted, or completed,
that cycle owns enforcement for the policy: the service does not also start
the ordinary warning/close/silent-installer path. This avoids racing a
self-update launch with another update action. An observed exit while
launch-on-exit is disabled is instead permanently recorded as
launch-disabled for that cycle, so ordinary enforcement continues and a later
configuration edit cannot launch the old cycle. Attempted or completed
self-update cycles never resume ordinary enforcement; a new server cycle ID
is required.

When a self-update cycle takes ownership, any already-running ordinary
enforcement task for that policy is cancelled and invalidated before launch
handling continues. State reconciliation also cancels/removes ordinary tasks
for policies that are absent or disabled in a newly received configuration.
Warnings are rechecked immediately before display; process kills and installer
starts are serialized with cancellation under the policy enforcement lock.
Thus cancellation wins before any new destructive action starts. An installer
that was already started is allowed to finish and is never killed.

Transition and launch outcomes are stored, without policy arguments or
credentials, in `C:\ProgramData\NemesysV2\update-mode-launch-ledger.json`.
The ledger is atomically replaced under a process-wide lock and marks an
attempt before process creation, ensuring at most one launch attempt per
policy/cycle across service restarts. Missing executables and failed process
creation consume that one attempt; already-running and compliant cycles are
recorded as completed. If the ledger cannot be read, validates as corrupt, or
cannot be atomically persisted, launch-on-exit fails closed and no launch is
authorized.

## Runtime logs

The service writes a daily log to:

```text
C:\ProgramData\NemesysV2\logs\client-YYYYMMDD.log
```

Only the current day's client log is retained. Older `client-YYYYMMDD.log`
files are removed when the service starts and when the logger rolls over to a
new day, so the client log directory does not grow indefinitely.

The log records evaluation/report summaries and warning requests, companion
launch/connection/authentication outcomes, postponements, unavailable companions,
process-close requests, and installation attempts.

Synchronization failures are also written to the Windows Application Event Log
under the `NemesysV2.Client` source. The service retries failed synchronization
every 30 seconds.

An x64 MSI wrapper is available under `installer/windows` and uses the same
DPAPI-backed silent installation flow. Build it on a Windows runner with
`build-msi.ps1`.