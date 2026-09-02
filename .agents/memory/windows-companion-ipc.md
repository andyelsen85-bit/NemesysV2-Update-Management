---
name: Windows companion IPC
description: Security boundary for communication between the LocalSystem client service and the interactive warning companion.
---

The LocalSystem service must create the first named-pipe instance with an explicit ACL. It may trust a warning response only after confirming the client is authenticated, runs in the selected interactive session, and is the installed NemesysV2 executable. Launch the short-lived companion with the active console or RDP user's token; do not rely on a LocalSystem-created logon task.

**Why:** If LocalSystem connects as a client to a user-owned or globally named pipe, a squatting server can impersonate the service. A LocalSystem logon task cannot reliably display UI in the user's desktop. Closing software when the authenticated companion is unavailable would silently destroy user work.

**How to apply:** Preserve service-owned IPC, first-instance protection, policy gating, and companion process/session validation whenever warning-dialog messages or responses change. Use separate deadlines for connection/authentication and for the user countdown response; start the response deadline only after the warning is flushed. Treat launch, connection, authentication, response, or confirmed process-closure failure as fail-safe: retry later without running installers.