using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace NemesysV2.Client;

internal sealed class SyncWorker(ClientConfiguration configuration, ILogger<SyncWorker> logger) : BackgroundService
{
    // The control plane certificate is administrator-managed and may be
    // self-signed, private-CA issued, expired, or hostname-mismatched. API-key
    // authentication still protects every synchronization request.
    private readonly HttpClient http = CreateHttpClient();
    private string? clientId;
    private string? syncEtag;
    private SyncConfig? cachedSyncConfig;

    private static HttpClient CreateHttpClient()
    {
        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator,
        };
        return new HttpClient(handler);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "NemesysV2 client started for hostname {Hostname}; server {Server}; port {Port}",
            configuration.Hostname,
            configuration.Server,
            configuration.Port);

        var initialJitterSeconds = Random.Shared.Next(0, 31);
        logger.LogDebug("Initial synchronization jitter is {DelaySeconds} seconds", initialJitterSeconds);
        await Task.Delay(TimeSpan.FromSeconds(initialJitterSeconds), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                clientId ??= await EnrollAsync(stoppingToken);
                var poll = await GetSyncConfigAsync(clientId, stoppingToken);
                if (poll.Modified)
                    await EvaluateAndReportAsync(poll.Config, stoppingToken);
                await Task.Delay(GetPollDelay(poll.Config.SyncIntervalSeconds), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                logger.LogError(
                    exception,
                    "NemesysV2 synchronization failed; retrying against {Server}:{Port}",
                    configuration.Server,
                    configuration.Port);
                await Task.Delay(TimeSpan.FromSeconds(30 + Random.Shared.Next(0, 16)), stoppingToken);
            }
        }
    }

    private async Task<string> EnrollAsync(CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Post, "/sync/enroll");
        request.Content = JsonContent.Create(
            new { address = await ResolveAddressAsync(configuration.Server, configuration.Port) },
            options: JsonOptions.Default);
        using var response = await http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var client = await response.Content.ReadFromJsonAsync<ClientResponse>(JsonOptions.Default, cancellationToken)
            ?? throw new InvalidOperationException("Enrollment response was empty.");
        return client.Id;
    }

    private async Task<SyncPollResult> GetSyncConfigAsync(string id, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Get, $"/sync/config?clientId={Uri.EscapeDataString(id)}");
        if (!string.IsNullOrWhiteSpace(syncEtag))
            request.Headers.TryAddWithoutValidation("If-None-Match", syncEtag);
        using var response = await http.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            if (cachedSyncConfig is null)
                throw new InvalidOperationException("Server returned 304 before the client had cached synchronization configuration.");
            logger.LogDebug("Synchronization configuration unchanged; server returned 304 for {Hostname}", configuration.Hostname);
            return new SyncPollResult(cachedSyncConfig, false);
        }
        response.EnsureSuccessStatusCode();
        var sync = await response.Content.ReadFromJsonAsync<SyncConfig>(JsonOptions.Default, cancellationToken)
            ?? throw new InvalidOperationException("Sync configuration response was empty.");
        syncEtag = response.Headers.ETag?.ToString();
        cachedSyncConfig = sync;
        logger.LogInformation("Downloaded synchronization configuration {ConfigVersion} for {Hostname}", sync.ConfigVersion, configuration.Hostname);
        return new SyncPollResult(sync, true);
    }

    private async Task EvaluateAndReportAsync(SyncConfig sync, CancellationToken cancellationToken)
    {
        var results = sync.Policies.Select(policy => (Policy: policy, Result: EvaluatePolicy(policy))).ToList();
        var nonCompliantPolicies = results.Where(item => !item.Result.Compliant).ToList();
        logger.LogInformation(
            "Evaluated {PolicyCount} policies for {Hostname}; {NonCompliantCount} require attention",
            results.Count, configuration.Hostname, nonCompliantPolicies.Count);
        if (nonCompliantPolicies.Count > 0)
        {
            foreach (var item in nonCompliantPolicies)
            {
                var processState = GetManagedProcessState(item.Policy);
                if (processState == ManagedProcessState.Unknown)
                {
                    logger.LogWarning(
                        "Unable to determine whether a managed process is running for {ApplicationName}; skipping warning, closure, and installation",
                        item.Policy.Name);
                    syncEtag = null;
                    continue;
                }
                if (processState == ManagedProcessState.NotRunning)
                {
                    logger.LogInformation(
                        "No managed process is running for {ApplicationName}; skipping the warning and process closure",
                        item.Policy.Name);
                    RunSilentInstallCommands(new[] { item.Policy });
                    // Re-evaluate on the next poll so a process started later is
                    // detected even when the server configuration is unchanged.
                    syncEtag = null;
                    continue;
                }

                var timeout = item.Policy.UpdateMode
                    ? Math.Max(1, item.Policy.UpdateModeCloseTimeoutSeconds)
                    : Math.Max(5, sync.NormalCloseTimeoutSeconds);
                var outcome = await SessionWarningChannel.ShowAsync(
                    item.Policy.Name,
                    timeout,
                    item.Policy.AllowPostpone,
                    logger,
                    cancellationToken);
                if (outcome == WarningOutcome.Postpone)
                {
                    logger.LogInformation("User postponed the controlled update for {ApplicationName}", item.Policy.Name);
                    syncEtag = null;
                    continue;
                }
                if (outcome == WarningOutcome.CompanionUnavailable)
                {
                    logger.LogWarning(
                        "Warning companion unavailable for {ApplicationName}; skipping process closure and installation",
                        item.Policy.Name);
                    // Request a fresh configuration next time: otherwise a
                    // cached 304 response would prevent another warning attempt.
                    syncEtag = null;
                    continue;
                }
                if (!CloseManagedProcesses(new[] { item.Policy }))
                {
                    logger.LogWarning(
                        "Managed process closure did not complete for {ApplicationName}; skipping installation",
                        item.Policy.Name);
                    // Request a fresh configuration so process closure and the
                    // installation can be retried rather than installing over
                    // a process that may still be running.
                    syncEtag = null;
                    continue;
                }
                RunSilentInstallCommands(new[] { item.Policy });
            }
        }

        using var request = CreateRequest(HttpMethod.Post, "/sync/report");
        request.Content = JsonContent.Create(new
        {
            clientId,
            clientName = configuration.Hostname,
            result = nonCompliantPolicies.Count > 0 ? "warning" : "success",
            applications = results.Select(item => item.Result),
        }, options: JsonOptions.Default);
        using var response = await http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        logger.LogInformation(
            "Reported evaluation for {Hostname}: {Result} ({ApplicationCount} applications)",
            configuration.Hostname, nonCompliantPolicies.Count > 0 ? "warning" : "success", results.Count);
    }

    private ApplicationResult EvaluatePolicy(SoftwarePolicy policy)
    {
        var checks = new List<PolicyCheckAudit>();
        foreach (var check in policy.ExeChecks)
        {
            var observed = ReadFileVersion(check.Executable);
            checks.Add(new PolicyCheckAudit(
                $"EXE [{check.Executable}]",
                DescribeObservedVersion(check.Executable, observed),
                DescribeExpected(check.TargetVersion, "version"),
                IsConfiguredMatch(observed.Raw, check.TargetVersion)));
        }
        foreach (var check in policy.IniChecks)
        {
            var observed = ReadIniValue(check.FilePath, check.Section, check.Key);
            checks.Add(new PolicyCheckAudit(
                $"INI [{check.FilePath}] [{check.Section}] {check.Key}",
                DescribeObservedIni(check.FilePath, observed),
                DescribeExpected(check.ExpectedValue, "value"),
                IsConfiguredMatch(observed.Raw, check.ExpectedValue)));
        }

        if (checks.Count == 0)
        {
            return new ApplicationResult(
                policy.Id, policy.Name, true,
                "no checks configured", "no checks configured");
        }

        return new ApplicationResult(
            policy.Id,
            policy.Name,
            checks.Count == 0 || checks.All(check => check.Compliant),
            string.Join("; ", checks.Select(check => $"{check.Label}: {check.Observed}")),
            string.Join("; ", checks.Select(check => $"{check.Label}: {check.Expected}")));
    }

    private bool CloseManagedProcesses(IEnumerable<SoftwarePolicy> policies)
    {
        var processNames = GetManagedProcessNames(policies);
        var closureSucceeded = true;
        foreach (var processName in processNames)
        {
            Process[] processes;
            try
            {
                processes = Process.GetProcessesByName(processName);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Unable to enumerate {ProcessName} for closure", processName);
                closureSucceeded = false;
                continue;
            }
            if (processes.Length == 0)
            {
                logger.LogInformation("No running process matched {ProcessName}; it is already closed", processName);
                continue;
            }

            foreach (var process in processes)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    if (process.WaitForExit(TimeSpan.FromSeconds(5)))
                        logger.LogInformation("Confirmed closure of {ProcessName} (PID {ProcessId})", processName, process.Id);
                    else
                    {
                        logger.LogWarning(
                            "Timed out waiting for {ProcessName} (PID {ProcessId}) to close after kill request",
                            processName, process.Id);
                        closureSucceeded = false;
                    }
                }
                catch (Exception exception)
                {
                    logger.LogWarning(exception, "Unable to close {ProcessName}", processName);
                    closureSucceeded = false;
                }
                finally { process.Dispose(); }
            }
        }

        var survivors = new List<string>();
        foreach (var processName in processNames)
        {
            try
            {
                foreach (var process in Process.GetProcessesByName(processName))
                {
                    try
                    {
                        survivors.Add($"{processName} (PID {process.Id})");
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Unable to verify closure of {ProcessName}", processName);
                closureSucceeded = false;
            }
        }

        if (survivors.Count > 0)
        {
            logger.LogWarning(
                "Managed processes remain after closure attempts: {SurvivingProcesses}",
                string.Join(", ", survivors));
            return false;
        }
        if (!closureSucceeded) return false;

        logger.LogInformation("Managed process closure completed; no configured processes remain");
        return true;
    }

    private ManagedProcessState GetManagedProcessState(SoftwarePolicy policy)
    {
        var processNames = GetManagedProcessNames(new[] { policy });
        if (processNames.Count == 0)
        {
            logger.LogInformation(
                "No managed process names are configured for {ApplicationName}",
                policy.Name);
            return ManagedProcessState.NotRunning;
        }

        foreach (var processName in processNames)
        {
            Process[] processes;
            try
            {
                processes = Process.GetProcessesByName(processName);
            }
            catch (Exception exception)
            {
                logger.LogWarning(
                    exception,
                    "Unable to enumerate managed process {ProcessName} for {ApplicationName}",
                    processName,
                    policy.Name);
                return ManagedProcessState.Unknown;
            }

            try
            {
                if (processes.Length == 0) continue;
                logger.LogInformation(
                    "Detected managed process {ProcessName} for {ApplicationName}: {ProcessIds}",
                    processName,
                    policy.Name,
                    string.Join(", ", processes.Select(process => process.Id)));
                return ManagedProcessState.Running;
            }
            finally
            {
                foreach (var process in processes) process.Dispose();
            }
        }

        logger.LogInformation(
            "No running process matched {ApplicationName}; configured process names: {ProcessNames}",
            policy.Name,
            string.Join(", ", processNames));
        return ManagedProcessState.NotRunning;
    }

    private static List<string> GetManagedProcessNames(IEnumerable<SoftwarePolicy> policies)
    {
        return policies
            .SelectMany(policy => policy.SupervisedExecutables
                .Concat(policy.ExeChecks.Select(check => check.Executable))
                .Append(policy.Executable))
            .Select(Path.GetFileNameWithoutExtension)
            .Where(name => !string.IsNullOrWhiteSpace(name) && name != "-")
            .Select(name => name!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private void RunSilentInstallCommands(IEnumerable<SoftwarePolicy> policies)
    {
        foreach (var check in policies.SelectMany(policy => policy.ExeChecks))
        {
            var observed = File.Exists(check.Executable)
                ? FileVersionInfo.GetVersionInfo(check.Executable).FileVersion ?? ""
                : "";
            if (observed == check.TargetVersion || string.IsNullOrWhiteSpace(check.InstallCommand)) continue;
            try
            {
                using var process = Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = $"/D /C {check.InstallCommand}",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
                logger.LogInformation("Started silent installation for {Executable}", check.Executable);
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Unable to start silent installation for {Executable}", check.Executable);
            }
        }
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, $"{configuration.ApiBase}{path}");
        request.Headers.Add("X-Nemesys-API-Key", configuration.ApiKey);
        request.Headers.Add("X-Nemesys-Hostname", configuration.Hostname);
        return request;
    }

    private static TimeSpan GetPollDelay(int intervalSeconds)
    {
        var baseline = Math.Max(10, intervalSeconds);
        var jittered = baseline * (0.9 + Random.Shared.NextDouble() * 0.2);
        return TimeSpan.FromSeconds(Math.Max(10, jittered));
    }

    private static bool IsConfiguredMatch(string observed, string expected) =>
        !string.IsNullOrWhiteSpace(observed) &&
        !string.IsNullOrWhiteSpace(expected) &&
        observed == expected;

    private static async Task<string> ResolveAddressAsync(string server, int port)
    {
        try
        {
            if (Uri.TryCreate(server, UriKind.Absolute, out var uri))
            {
                var remoteAddress = (await Dns.GetHostAddressesAsync(uri.Host))
                    .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork);
                if (remoteAddress is not null)
                {
                    using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                    await socket.ConnectAsync(new IPEndPoint(remoteAddress, port));
                    if (socket.LocalEndPoint is IPEndPoint localEndpoint && IsUsableIpv4(localEndpoint.Address))
                        return localEndpoint.Address.ToString();
                }
            }
        }
        catch (Exception)
        {
            // DNS/socket routing is only an informational enhancement. Fall
            // back to adapter inspection if it is unavailable.
        }
        return ResolveInterfaceAddress();
    }

    private static string ResolveInterfaceAddress()
    {
        var candidates = NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up &&
                adapter.NetworkInterfaceType is not NetworkInterfaceType.Loopback and not NetworkInterfaceType.Tunnel)
            .Select(adapter => adapter.GetIPProperties())
            .Select(properties => new
            {
                HasDefaultGateway = properties.GatewayAddresses.Any(gateway =>
                    gateway.Address.AddressFamily == AddressFamily.InterNetwork &&
                    !gateway.Address.Equals(IPAddress.Any)),
                Addresses = properties.UnicastAddresses
                    .Select(address => address.Address)
                    .Where(IsUsableIpv4),
            })
            .ToList();
        return candidates.Where(candidate => candidate.HasDefaultGateway)
            .SelectMany(candidate => candidate.Addresses)
            .Concat(candidates.SelectMany(candidate => candidate.Addresses))
            .Select(address => address.ToString())
            .FirstOrDefault() ?? "unknown";
    }

    private static bool IsUsableIpv4(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address))
            return false;
        var bytes = address.GetAddressBytes();
        return !(bytes[0] == 169 && bytes[1] == 254); // APIPA
    }

    private static RawCheckValue ReadFileVersion(string path)
    {
        if (!File.Exists(path)) return new("", "file not found");
        try
        {
            var version = FileVersionInfo.GetVersionInfo(path).FileVersion;
            return string.IsNullOrWhiteSpace(version)
                ? new("", "version unavailable")
                : new(version, version);
        }
        catch (Exception)
        {
            return new("", "version unavailable");
        }
    }

    private static string DescribeObservedVersion(string path, RawCheckValue observed) => observed.Display;
    private static string DescribeObservedIni(string path, RawCheckValue observed) =>
        File.Exists(path) ? observed.Display : "file not found";
    private static string DescribeExpected(string value, string kind) =>
        string.IsNullOrWhiteSpace(value) ? $"expected {kind} not configured" : value;

    private static RawCheckValue ReadIniValue(string path, string section, string key)
    {
        if (!File.Exists(path)) return new("", "file not found");
        var currentSection = "";
        foreach (var line in File.ReadLines(path))
        {
            var value = line.Trim();
            if (value.StartsWith("[") && value.EndsWith("]"))
            {
                currentSection = value[1..^1].Trim();
                continue;
            }
            var separator = value.IndexOf('=');
            if (separator <= 0 || !currentSection.Equals(section, StringComparison.OrdinalIgnoreCase)) continue;
            if (value[..separator].Trim().Equals(key, StringComparison.OrdinalIgnoreCase))
            {
                var raw = value[(separator + 1)..].Trim();
                return string.IsNullOrWhiteSpace(raw)
                    ? new(raw, "value unavailable")
                    : new(raw, raw);
            }
        }
        return new("", "value not found");
    }
}

internal static class SessionWarningChannel
{
    public static async Task<WarningOutcome> ShowAsync(
        string applicationName, int seconds, bool allowPostpone, ILogger logger, CancellationToken cancellationToken)
    {
        try
        {
            await using var pipe = CreateServer();
            var sessionId = SessionCompanionLauncher.GetActiveSessionId(logger);
            if (sessionId is null)
            {
                logger.LogWarning("Warning requested for {ApplicationName}, but no active user session exists", applicationName);
                return WarningOutcome.CompanionUnavailable;
            }

            logger.LogInformation("Warning requested for {ApplicationName} in session {SessionId}", applicationName, sessionId);
            if (!SessionCompanionLauncher.IsCompanionRunning(sessionId.Value) &&
                !SessionCompanionLauncher.Launch(sessionId.Value, logger))
                return WarningOutcome.CompanionUnavailable;

            using var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            connectionCancellation.CancelAfter(TimeSpan.FromSeconds(15));
            await pipe.WaitForConnectionAsync(connectionCancellation.Token);
            var isAuthenticatedUser = false;
            pipe.RunAsClient(() =>
            {
                using var identity = WindowsIdentity.GetCurrent();
                isAuthenticatedUser = identity.IsAuthenticated && identity.User is not null &&
                    !identity.User.IsWellKnown(WellKnownSidType.AnonymousSid);
            });
            if (!isAuthenticatedUser || !IsExpectedSessionCompanion(pipe, sessionId.Value))
                throw new UnauthorizedAccessException("The pipe client is not the installed NemesysV2 session companion.");
            logger.LogInformation("Warning companion connected and authenticated for {ApplicationName}", applicationName);
            await JsonSerializer.SerializeAsync(
                pipe, new WarningMessage(applicationName, seconds, allowPostpone), JsonOptions.Default, connectionCancellation.Token);
            await pipe.FlushAsync(connectionCancellation.Token);

            using var responseCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            responseCancellation.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, seconds) + 15));
            var response = await JsonSerializer.DeserializeAsync<WarningResponse>(
                pipe, JsonOptions.Default, responseCancellation.Token);
            if (response is null) throw new IOException("Warning companion closed without a response.");
            var outcome = allowPostpone && response.Postponed ? WarningOutcome.Postpone : WarningOutcome.Proceed;
            logger.LogInformation("Warning outcome for {ApplicationName}: {Outcome}", applicationName, outcome);
            return outcome;
        }
        catch (Exception exception) when (exception is TimeoutException or IOException or JsonException or ObjectDisposedException or UnauthorizedAccessException ||
            (exception is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            logger.LogWarning(exception, "Warning companion unavailable for {ApplicationName}", applicationName);
            return WarningOutcome.CompanionUnavailable;
        }
    }

    private static NamedPipeServerStream CreateServer()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            "NemesysV2.UserSession",
                PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance,
            0,
            0,
            security);
    }

    private static bool IsExpectedSessionCompanion(NamedPipeServerStream pipe, int expectedSessionId)
    {
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out var processId) ||
            processId > int.MaxValue)
            return false;

        try
        {
            using var process = Process.GetProcessById((int)processId);
            var expectedPath = Environment.ProcessPath;
            var actualPath = process.MainModule?.FileName;
            return process.SessionId == expectedSessionId &&
                !string.IsNullOrWhiteSpace(expectedPath) &&
                !string.IsNullOrWhiteSpace(actualPath) &&
                Path.GetFullPath(actualPath).Equals(Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase);
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipeHandle, out uint clientProcessId);

}

internal enum WarningOutcome { Proceed, Postpone, CompanionUnavailable }
internal enum ManagedProcessState { Running, NotRunning, Unknown }

internal static class SessionCompanionLauncher
{
    private const uint InvalidSessionId = 0xFFFFFFFF;
    private const uint TokenAllAccess = 0xF01FF;
    private const uint CreateUnicodeEnvironment = 0x00000400;

    public static int? GetActiveSessionId(ILogger logger)
    {
        IntPtr sessionInfo = IntPtr.Zero;
        try
        {
            if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out sessionInfo, out var count))
            {
                logger.LogWarning("Unable to enumerate active user sessions ({Error})", Marshal.GetLastWin32Error());
                return null;
            }

            var recordSize = Marshal.SizeOf<WtsSessionInfo>();
            var activeSessions = new List<int>();
            for (var index = 0; index < count; index++)
            {
                var item = Marshal.PtrToStructure<WtsSessionInfo>(
                    IntPtr.Add(sessionInfo, index * recordSize));
                if (item.State == WtsConnectState.Active && item.SessionId != 0)
                    activeSessions.Add(item.SessionId);
            }

            if (activeSessions.Count == 0) return null;
            var consoleSession = WTSGetActiveConsoleSessionId();
            if (consoleSession != InvalidSessionId && activeSessions.Contains((int)consoleSession))
                return (int)consoleSession;
            return activeSessions.Min();
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Unable to select an active user session for the warning companion");
            return null;
        }
        finally
        {
            if (sessionInfo != IntPtr.Zero) WTSFreeMemory(sessionInfo);
        }
    }

    public static bool IsCompanionRunning(int sessionId)
    {
        var expectedPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(expectedPath)) return false;
        return Process.GetProcesses().Any(process =>
        {
            try
            {
                return process.SessionId == sessionId &&
                    Path.GetFullPath(process.MainModule?.FileName ?? "").Equals(
                    Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
            finally { process.Dispose(); }
        });
    }

    public static bool Launch(int sessionId, ILogger logger)
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable))
        {
            logger.LogWarning("Cannot launch warning companion because executable path is unavailable");
            return false;
        }
        if (!WTSQueryUserToken((uint)sessionId, out var userToken))
        {
            logger.LogWarning("Unable to obtain active session user token ({Error})", Marshal.GetLastWin32Error());
            return false;
        }
        IntPtr primaryToken = IntPtr.Zero, environment = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(userToken, TokenAllAccess, IntPtr.Zero, 2, 1, out primaryToken))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (!CreateEnvironmentBlock(out environment, primaryToken, false))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var startup = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>(), lpDesktop = @"winsta0\default" };
            var commandLine = new StringBuilder($"\"{executable}\" --session-companion");
            if (!CreateProcessAsUser(primaryToken, executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CreateUnicodeEnvironment, environment, Path.GetDirectoryName(executable), ref startup, out var process))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            logger.LogInformation("Launched warning companion in active session {SessionId}", sessionId);
            return true;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Unable to launch warning companion in active session {SessionId}", sessionId);
            return false;
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            CloseHandle(userToken);
        }
    }

    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSEnumerateSessions(
        IntPtr server, int reserved, int version, out IntPtr sessionInfo, out int count);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr primaryToken);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
    [DllImport("userenv.dll")] private static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(
        IntPtr token, string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string? currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo { public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct WtsSessionInfo { public int SessionId; public IntPtr WinStationName; public WtsConnectState State; }
    private enum WtsConnectState { Active = 0 }
}

internal sealed class SessionCompanion
{
    public static async Task RunAsync()
    {
        try
        {
            await using var pipe = new NamedPipeClientStream(
                ".",
                "NemesysV2.UserSession",
                PipeDirection.InOut,
                PipeOptions.Asynchronous,
                TokenImpersonationLevel.Identification);
            await pipe.ConnectAsync(5000);
            var warning = await JsonSerializer.DeserializeAsync<WarningMessage>(pipe, JsonOptions.Default);
            if (warning is null) return;

            using var form = new Form
            {
                Width = 600, Height = 270, Text = "NemesysV2 update notice",
                StartPosition = FormStartPosition.CenterScreen, TopMost = true,
                FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false,
                MinimizeBox = false, ControlBox = false, BackColor = Color.White,
            };
            var title = new Label
        {
            AutoSize = false, Left = 28, Top = 24, Width = 530, Height = 32,
            Font = new Font("Segoe UI Semibold", 16), Text = $"{warning.ApplicationName} needs to close",
        };
            var detail = new Label
        {
            AutoSize = false, Left = 30, Top = 64, Width = 525, Height = 60,
            Font = new Font("Segoe UI", 10), ForeColor = Color.FromArgb(75, 85, 99),
            Text = "Maintenance is running\r\nPlease save your work. The application will close automatically so maintenance can continue.",
        };
            var countdown = new Label
        {
            AutoSize = false, Left = 30, Top = 132, Width = 525, Height = 28,
            TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI Semibold", 10),
            ForeColor = Color.FromArgb(153, 96, 0),
        };
            var closeButton = new Button
        {
            Width = 170, Height = 36, Left = 382, Top = 184, Text = "Close application now",
            Font = new Font("Segoe UI Semibold", 9), BackColor = Color.FromArgb(8, 118, 71),
            ForeColor = Color.White, FlatStyle = FlatStyle.Flat,
        };
            closeButton.FlatAppearance.BorderSize = 0;
            var postponed = false;
            closeButton.Click += (_, _) => form.Close();
            form.Controls.AddRange(new Control[] { title, detail, countdown, closeButton });
            if (warning.AllowPostpone)
            {
                var postponeButton = new Button
                {
                    Width = 130, Height = 36, Left = 242, Top = 184, Text = "Postpone",
                    Font = new Font("Segoe UI Semibold", 9), FlatStyle = FlatStyle.System,
                };
                postponeButton.Click += (_, _) =>
                {
                    postponed = true;
                    form.Close();
                };
                form.Controls.Add(postponeButton);
            }
            using var timer = new System.Windows.Forms.Timer { Interval = 1000 };
            var remaining = warning.Seconds;
            countdown.Text = $"Closing in 00:{remaining:00}";
            timer.Tick += (_, _) =>
            {
                remaining--;
                countdown.Text = $"Closing in {TimeSpan.FromSeconds(Math.Max(0, remaining)):mm\\:ss}";
                if (remaining <= 0) { timer.Stop(); form.Close(); }
            };
            timer.Start();
            Application.Run(form);
            await JsonSerializer.SerializeAsync(pipe, new WarningResponse(postponed), JsonOptions.Default);
            await pipe.FlushAsync();
        }
        catch (Exception exception) when (exception is OperationCanceledException or TimeoutException or IOException or JsonException or ObjectDisposedException)
        {
            // The service treats an unavailable companion as fail-safe. IPC
            // shutdown must not turn the interactive helper into a crashed process.
        }
    }
}

internal sealed record WarningMessage(string ApplicationName, int Seconds, bool AllowPostpone);
internal sealed record WarningResponse(bool Postponed);
internal sealed record RawCheckValue(string Raw, string Display);
internal sealed record PolicyCheckAudit(string Label, string Observed, string Expected, bool Compliant);
internal sealed record ClientResponse(string Id);
internal sealed record SyncPollResult(SyncConfig Config, bool Modified);
internal sealed record SyncConfig(
    string ClientId,
    int SyncIntervalSeconds,
    string ConfigVersion,
    bool UpdateMode,
    int NormalCloseTimeoutSeconds,
    int CloseOnStartTimeoutSeconds,
    List<SoftwarePolicy> Policies);
internal sealed record SoftwarePolicy(
    string Id,
    string Name,
    string Executable,
    string TargetVersion,
    List<string> SupervisedExecutables,
    List<ExeCheck> ExeChecks,
    List<IniCheck> IniChecks,
    bool UpdateMode,
    int UpdateModeCloseTimeoutSeconds,
    bool AllowPostpone);
internal sealed record ExeCheck(string Executable, string TargetVersion, string? InstallCommand);
internal sealed record IniCheck(string FilePath, string Section, string Key, string ExpectedValue);
internal sealed record ApplicationResult(
    string SoftwareId,
    string SoftwareName,
    bool Compliant,
    string ObservedVersion,
    string ExpectedVersion);