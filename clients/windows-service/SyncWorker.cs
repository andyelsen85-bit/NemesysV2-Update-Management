using System.Diagnostics;
using System.Globalization;
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
    private static readonly string ClientVersion =
        typeof(SyncWorker).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    private readonly HttpClient http = CreateHttpClient();
    private readonly Dictionary<string, bool> lastReportedCompliance = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, EnforcementState> enforcementStates = new(StringComparer.OrdinalIgnoreCase);
    private readonly object enforcementLock = new();
    private string? clientId;
    private string? syncEtag;
    private SyncConfig? cachedSyncConfig;

    private static HttpClient CreateHttpClient()
    {
        return new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
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
            var scanStarted = Stopwatch.GetTimestamp();
            var evaluationStarted = false;
            try
            {
                clientId ??= await EnrollAsync(stoppingToken);
                var poll = await GetSyncConfigAsync(clientId, stoppingToken);
                evaluationStarted = true;
                await EvaluateAndReportAsync(poll.Config, poll.Modified, stoppingToken);
                await DelayUntilNextScanAsync(
                    scanStarted,
                    GetPollDelay(poll.Config),
                    stoppingToken);
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
                if (!evaluationStarted && cachedSyncConfig is not null)
                {
                    try
                    {
                        logger.LogWarning(
                            "Using the cached synchronization configuration to continue local process monitoring");
                        await EvaluateAndReportAsync(cachedSyncConfig, false, stoppingToken);
                    }
                    catch (Exception cachedEvaluationException)
                    {
                        logger.LogError(
                            cachedEvaluationException,
                            "Cached policy monitoring completed with a reporting or enforcement error");
                    }
                }
                await DelayUntilNextScanAsync(
                    scanStarted,
                    GetPollDelay(cachedSyncConfig),
                    stoppingToken);
            }
        }
    }

    private async Task<string> EnrollAsync(CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Post, "/sync/enroll");
        request.Content = JsonContent.Create(
            new
            {
                address = await ResolveAddressAsync(configuration.Server, configuration.Port),
                clientVersion = ClientVersion,
            },
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

    private async Task EvaluateAndReportAsync(
        SyncConfig sync,
        bool configurationChanged,
        CancellationToken cancellationToken)
    {
        ReconcileEnforcementStates(sync.Policies.Where(policy => policy.Enabled).Select(policy => policy.Id));
        var results = sync.Policies.Select(policy => (Policy: policy, Result: EvaluatePolicy(policy))).ToList();
        var nonCompliantPolicies = results.Where(item => !item.Result.Compliant).ToList();
        var complianceChanged = results.Any(item =>
            !lastReportedCompliance.TryGetValue(item.Policy.Id, out var lastCompliant) ||
            lastCompliant != item.Result.Compliant);
        var shouldReport = configurationChanged || complianceChanged;
        logger.LogInformation(
            "Evaluated {PolicyCount} policies for {Hostname}; {NonCompliantCount} require attention",
            results.Count, configuration.Hostname, nonCompliantPolicies.Count);
        foreach (var item in results)
        {
            // An observed launch-on-exit cycle owns this scan (and later scans
            // for that cycle). Do not race its self-update launch with the
            // ordinary warning/close/silent-installer enforcement path.
            if (!ProcessUpdateModeExit(item.Policy, item.Result.Compliant))
                ScheduleEnforcement(item.Policy, item.Result.Compliant, cancellationToken);
        }
        UpdateModeLaunchLedger.CleanReceivedPolicies(sync.Policies.Select(policy => policy.Id), logger);

        if (nonCompliantPolicies.Count > 0)
        {
            logger.LogDebug("Scheduled enforcement, where needed, for {PolicyCount} noncompliant policies", nonCompliantPolicies.Count);
        }

        if (!shouldReport) return;

        using var request = CreateRequest(HttpMethod.Post, "/sync/report");
        request.Content = JsonContent.Create(new
        {
            clientId,
            clientName = configuration.Hostname,
            clientVersion = ClientVersion,
            result = nonCompliantPolicies.Count > 0 ? "warning" : "success",
            applications = results.Select(item => item.Result),
        }, options: JsonOptions.Default);
        using var response = await http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        logger.LogInformation(
            "Reported evaluation for {Hostname}: {Result} ({ApplicationCount} applications)",
            configuration.Hostname, nonCompliantPolicies.Count > 0 ? "warning" : "success", results.Count);
        lastReportedCompliance.Clear();
        foreach (var item in results)
            lastReportedCompliance[item.Policy.Id] = item.Result.Compliant;
    }

    private void ScheduleEnforcement(
        SoftwarePolicy policy, bool compliant, CancellationToken cancellationToken)
    {
        if (!policy.Enabled) return;
        var signature = GetPolicySignature(policy);
        lock (enforcementLock)
        {
            if (!enforcementStates.TryGetValue(policy.Id, out var state))
            {
                state = new EnforcementState();
                enforcementStates.Add(policy.Id, state);
            }
            state.Compliant = compliant;

            if (compliant)
            {
                state.Generation++;
                state.Cancellation?.Cancel();
                state.CooldownUntil = DateTimeOffset.MinValue;
                state.Signature = signature;
                state.LastObservedRunning = null;
                return;
            }

            if (!string.Equals(state.Signature, signature, StringComparison.Ordinal))
            {
                state.Generation++;
                state.Cancellation?.Cancel();
                state.Signature = signature;
                state.CooldownUntil = DateTimeOffset.MinValue;
                state.LastObservedRunning = null;
            }
            if (state.Task is { IsCompleted: false })
                return;

            var processState = GetManagedProcessState(policy);
            if (processState == ManagedProcessState.Unknown)
            {
                logger.LogWarning(
                    "Unable to determine whether a managed process is running for {ApplicationName}; skipping warning, closure, and installation",
                    policy.Name);
                state.CooldownUntil = DateTimeOffset.UtcNow.AddMinutes(1);
                return;
            }
            var processRestarted = processState == ManagedProcessState.Running &&
                state.LastObservedRunning == false;
            state.LastObservedRunning = processState == ManagedProcessState.Running;
            if (state.CooldownUntil > DateTimeOffset.UtcNow)
            {
                if (processRestarted)
                {
                    state.CooldownUntil = DateTimeOffset.MinValue;
                    logger.LogInformation(
                        "Managed process for {ApplicationName} restarted; clearing enforcement cooldown",
                        policy.Name);
                }
                else
                {
                    return;
                }
            }

            state.Cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var enforcementCancellationToken = state.Cancellation.Token;
            var generation = state.Generation;
            state.Task = Task.Run(
                () => EnforcePolicyAsync(policy, state, signature, generation, enforcementCancellationToken),
                CancellationToken.None);
            _ = state.Task.ContinueWith(task =>
            {
                if (task.Exception is not null)
                    logger.LogError(task.Exception, "Background enforcement failed for {ApplicationName}", policy.Name);
                lock (enforcementLock)
                {
                    if (ReferenceEquals(state.Task, task))
                    {
                        state.Cancellation?.Dispose();
                        state.Cancellation = null;
                    }
                }
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        }
    }

    private async Task EnforcePolicyAsync(
        SoftwarePolicy policy,
        EnforcementState state, string signature, int generation, CancellationToken cancellationToken)
    {
        try
        {
            if (!IsCurrentEnforcement(state, signature, generation, cancellationToken)) return;
            var processState = GetManagedProcessState(policy);
            if (processState == ManagedProcessState.Unknown)
            {
                logger.LogWarning(
                    "Unable to confirm managed process state for {ApplicationName}; skipping warning, closure, and installation",
                    policy.Name);
                SetCooldown(state, signature, TimeSpan.FromMinutes(1));
                return;
            }
            if (processState == ManagedProcessState.NotRunning)
            {
                logger.LogInformation("No managed process is running for {ApplicationName}; running silent installation without a warning", policy.Name);
                if (!IsCurrentEnforcement(state, signature, generation, cancellationToken)) return;
                var installationAttempted = await RunSilentInstallCommandsAsync(policy, state, signature, generation, cancellationToken);
                SetCooldownOrClear(state, signature, installationAttempted);
                return;
            }

            if (!IsCurrentEnforcement(state, signature, generation, cancellationToken)) return;
            var timeout = policy.UpdateMode
                ? Math.Max(1, policy.UpdateModeCloseTimeoutSeconds)
                : Math.Max(1, policy.NormalCloseTimeoutSeconds);
            if (!IsCurrentEnforcement(state, signature, generation, cancellationToken)) return;
            var outcome = await SessionWarningChannel.ShowAsync(
                policy.Name, timeout, policy.AllowPostpone, logger, cancellationToken);
            if (outcome == WarningOutcome.Postpone)
            {
                logger.LogInformation("User postponed the controlled update for {ApplicationName}", policy.Name);
                SetCooldown(state, signature, TimeSpan.FromMinutes(5));
                return;
            }
            if (outcome == WarningOutcome.CompanionUnavailable)
            {
                logger.LogWarning("Warning companion unavailable for {ApplicationName}; skipping process closure and installation", policy.Name);
                SetCooldown(state, signature, TimeSpan.FromMinutes(1));
                return;
            }

            if (!IsCurrentEnforcement(state, signature, generation, cancellationToken)) return;
            var currentResult = EvaluatePolicy(policy);
            if (currentResult.Compliant)
            {
                logger.LogInformation(
                    "Policy {ApplicationName} became compliant before process closure; skipping closure and installation",
                    policy.Name);
                return;
            }

            processState = GetManagedProcessState(policy);
            if (processState == ManagedProcessState.Unknown)
            {
                logger.LogWarning(
                    "Unable to reconfirm managed process state for {ApplicationName}; skipping closure and installation",
                    policy.Name);
                SetCooldown(state, signature, TimeSpan.FromMinutes(1));
                return;
            }
            if (processState == ManagedProcessState.NotRunning)
            {
                logger.LogInformation(
                    "Managed process for {ApplicationName} exited before closure; continuing without a kill",
                    policy.Name);
                if (!IsCurrentEnforcement(state, signature, generation, cancellationToken)) return;
                var installationAttempted = await RunSilentInstallCommandsAsync(policy, state, signature, generation, cancellationToken);
                SetCooldownOrClear(state, signature, installationAttempted);
                return;
            }

            if (!IsCurrentEnforcement(state, signature, generation, cancellationToken) ||
                !CloseManagedProcesses(new[] { policy }, state, signature, generation, cancellationToken))
            {
                logger.LogWarning("Managed process closure did not complete for {ApplicationName}; skipping installation", policy.Name);
                SetCooldown(state, signature, TimeSpan.FromMinutes(1));
                return;
            }
            RecordObservedProcessState(state, signature, ManagedProcessState.NotRunning);
            var installAttemptedAfterClosure = await RunSilentInstallCommandsAsync(policy, state, signature, generation, cancellationToken);
            SetCooldownOrClear(state, signature, installAttemptedAfterClosure);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("Background enforcement cancelled for {ApplicationName}", policy.Name);
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Background enforcement failed for {ApplicationName}", policy.Name);
            SetCooldown(state, signature, TimeSpan.FromMinutes(1));
        }
    }

    private bool IsCurrentEnforcement(
        EnforcementState state,
        string signature,
        int generation,
        CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested) return false;
        lock (enforcementLock)
        {
            return !state.Compliant &&
                state.Generation == generation &&
                string.Equals(state.Signature, signature, StringComparison.Ordinal) &&
                !cancellationToken.IsCancellationRequested;
        }
    }

    private void SetCooldown(EnforcementState state, string signature, TimeSpan duration)
    {
        lock (enforcementLock)
        {
            if (string.Equals(state.Signature, signature, StringComparison.Ordinal))
                state.CooldownUntil = DateTimeOffset.UtcNow.Add(duration);
        }
    }

    private void SetCooldownOrClear(EnforcementState state, string signature, bool installationAttempted)
    {
        if (installationAttempted)
            SetCooldown(state, signature, TimeSpan.FromMinutes(5));
        else
            ClearCooldown(state, signature);
    }

    private void ClearCooldown(EnforcementState state, string signature)
    {
        lock (enforcementLock)
        {
            if (string.Equals(state.Signature, signature, StringComparison.Ordinal))
                state.CooldownUntil = DateTimeOffset.MinValue;
        }
    }

    private void RecordObservedProcessState(
        EnforcementState state,
        string signature,
        ManagedProcessState processState)
    {
        if (processState == ManagedProcessState.Unknown) return;
        lock (enforcementLock)
        {
            if (string.Equals(state.Signature, signature, StringComparison.Ordinal))
                state.LastObservedRunning = processState == ManagedProcessState.Running;
        }
    }

    private static string GetPolicySignature(SoftwarePolicy policy) =>
        JsonSerializer.Serialize(policy, JsonOptions.Default);

    private bool ProcessUpdateModeExit(SoftwarePolicy policy, bool compliant)
    {
        if (!policy.Enabled || string.IsNullOrWhiteSpace(policy.UpdateModeCycleId))
            return false;

        var cycleId = policy.UpdateModeCycleId;
        if (policy.UpdateMode)
        {
            UpdateModeLaunchLedger.ObserveActive(policy.Id, cycleId, logger);
            return false;
        }

        var exitState = UpdateModeLaunchLedger.ObserveExit(policy.Id, cycleId, logger);
        if (exitState == UpdateModeExitState.SelfUpdateHandled)
        {
            SuppressOrdinaryEnforcement(policy.Id);
            return true;
        }
        if (!policy.LaunchOnExitUpdateMode)
        {
            // Consume an observed exit while the option is off. A later
            // configuration edit must not reinterpret this old cycle as a
            // newly eligible self-update launch.
            if (exitState == UpdateModeExitState.Pending)
                UpdateModeLaunchLedger.MarkLaunchDisabled(policy.Id, cycleId, logger);
            return false;
        }
        if (exitState != UpdateModeExitState.Pending)
            return false; // Initial false configuration and restarted services are not exits.

        SuppressOrdinaryEnforcement(policy.Id);
        if (compliant)
        {
            UpdateModeLaunchLedger.Complete(policy.Id, cycleId, "compliant", logger);
            return true;
        }

        var sessionId = SessionCompanionLauncher.GetActiveSessionId(logger);
        if (sessionId is null)
        {
            logger.LogInformation("Update-mode exit launch for {ApplicationName} remains pending because no active user session exists", policy.Name);
            return true;
        }

        // A scan can be delayed; re-evaluate directly before the one allowed launch.
        if (EvaluatePolicy(policy).Compliant)
        {
            UpdateModeLaunchLedger.Complete(policy.Id, cycleId, "compliant before launch", logger);
            return true;
        }
        var executable = policy.LaunchExecutablePath;
        if (!string.IsNullOrWhiteSpace(executable) &&
            Path.IsPathFullyQualified(executable) &&
            SessionCompanionLauncher.IsExecutableRunningInSession(executable, sessionId.Value))
        {
            UpdateModeLaunchLedger.Complete(policy.Id, cycleId, "already running", logger);
            logger.LogInformation("Update-mode exit launch skipped for {ApplicationName}; executable is already running in session {SessionId}", policy.Name, sessionId);
            return true;
        }
        if (string.IsNullOrWhiteSpace(executable) ||
            !Path.IsPathFullyQualified(executable) ||
            !File.Exists(executable))
        {
            UpdateModeLaunchLedger.Attempt(policy.Id, cycleId, "missing executable", logger);
            logger.LogWarning("Update-mode exit launch for {ApplicationName} was not attempted because its executable is unavailable", policy.Name);
            return true;
        }

        // Persist this state before CreateProcessAsUser: a crash/restart can
        // turn a launch into a failed attempt, but can never duplicate it.
        if (!UpdateModeLaunchLedger.Attempt(policy.Id, cycleId, "launching", logger))
            return true;
        if (SessionCompanionLauncher.LaunchExecutable(
                sessionId.Value, executable, policy.LaunchArguments, logger))
            logger.LogInformation("Started update-mode exit executable for {ApplicationName} in session {SessionId}", policy.Name, sessionId);
        else
            logger.LogWarning("Update-mode exit executable launch failed for {ApplicationName}; this cycle will not be retried", policy.Name);
        return true;
    }

    private void ReconcileEnforcementStates(IEnumerable<string> enabledPolicyIds)
    {
        var enabled = new HashSet<string>(enabledPolicyIds, StringComparer.OrdinalIgnoreCase);
        lock (enforcementLock)
        {
            foreach (var item in enforcementStates.Where(item => !enabled.Contains(item.Key)).ToList())
            {
                item.Value.Generation++;
                item.Value.Compliant = true;
                item.Value.Cancellation?.Cancel();
                enforcementStates.Remove(item.Key);
                logger.LogInformation("Cancelled ordinary enforcement for policy {PolicyId} because it is no longer received as enabled", item.Key);
            }
        }
    }

    private void SuppressOrdinaryEnforcement(string policyId)
    {
        lock (enforcementLock)
        {
            if (!enforcementStates.TryGetValue(policyId, out var state)) return;
            state.Generation++;
            state.Compliant = true;
            state.Cancellation?.Cancel();
            logger.LogInformation("Cancelled ordinary enforcement for policy {PolicyId}; update-mode exit owns this cycle", policyId);
        }
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
                DescribeExpected(check.TargetVersion, "version", check.ComparisonOperator),
                IsConfiguredMatch(observed.Raw, check.TargetVersion, check.ComparisonOperator)));
        }
        foreach (var check in policy.IniChecks)
        {
            var observed = ReadIniValue(check.FilePath, check.Section, check.Key);
            checks.Add(new PolicyCheckAudit(
                $"INI [{check.FilePath}] [{check.Section}] {check.Key}",
                DescribeObservedIni(check.FilePath, observed),
                DescribeExpected(check.ExpectedValue, "value", check.ComparisonOperator),
                IsConfiguredMatch(observed.Raw, check.ExpectedValue, check.ComparisonOperator)));
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

    private bool CloseManagedProcesses(
        IEnumerable<SoftwarePolicy> policies,
        EnforcementState state,
        string signature,
        int generation,
        CancellationToken cancellationToken)
    {
        var processNames = GetManagedProcessNames(policies);
        var closureSucceeded = true;
        foreach (var processName in processNames)
        {
            cancellationToken.ThrowIfCancellationRequested();
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
                    if (!TryKillManagedProcess(process, state, signature, generation, cancellationToken))
                    {
                        logger.LogInformation("Stopped process closure because ordinary enforcement was cancelled or superseded");
                        return false;
                    }
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

    private bool TryKillManagedProcess(
        Process process,
        EnforcementState state,
        string signature,
        int generation,
        CancellationToken cancellationToken)
    {
        // Serialize the irreversible Kill call with cancellation/suppression.
        lock (enforcementLock)
        {
            if (cancellationToken.IsCancellationRequested ||
                state.Compliant ||
                state.Generation != generation ||
                !string.Equals(state.Signature, signature, StringComparison.Ordinal))
                return false;
            process.Kill(entireProcessTree: true);
            return true;
        }
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

    private async Task<bool> RunSilentInstallCommandsAsync(
        SoftwarePolicy policy,
        EnforcementState state,
        string signature,
        int generation,
        CancellationToken cancellationToken)
    {
        var installationAttempted = false;
        foreach (var check in policy.ExeChecks)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var observed = ReadFileVersion(check.Executable);
            if (IsConfiguredMatch(observed.Raw, check.TargetVersion, check.ComparisonOperator) ||
                string.IsNullOrWhiteSpace(check.InstallCommand)) continue;
            installationAttempted = true;
            try
            {
                using var process = StartSilentInstallCommand(
                    check, state, signature, generation, cancellationToken);
                if (process is null)
                {
                    logger.LogInformation(
                        "Skipped silent installation for {Executable} because ordinary enforcement was cancelled or superseded",
                        check.Executable);
                    return installationAttempted;
                }
                logger.LogInformation(
                    "Started silent installation for {Executable} (PID {ProcessId})",
                    check.Executable, process.Id);
                // Once launched, retain the Process handle until completion. This
                // prevents a subsequent scan from launching a duplicate command.
                await process.WaitForExitAsync(CancellationToken.None);
                logger.LogInformation(
                    "Silent installation for {Executable} (PID {ProcessId}) exited with code {ExitCode}",
                    check.Executable, process.Id, process.ExitCode);
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Unable to start silent installation for {Executable}", check.Executable);
            }
        }
        return installationAttempted;
    }

    private Process? StartSilentInstallCommand(
        ExeCheck check,
        EnforcementState state,
        string signature,
        int generation,
        CancellationToken cancellationToken)
    {
        // Starting cmd.exe is the irreversible part of ordinary enforcement.
        // Hold the same lock used by cancellation while evaluating state and
        // starting it, so cancellation either wins first or follows a process
        // that was already launched (which we intentionally never kill).
        lock (enforcementLock)
        {
            if (cancellationToken.IsCancellationRequested ||
                state.Compliant ||
                state.Generation != generation ||
                !string.Equals(state.Signature, signature, StringComparison.Ordinal))
                return null;
            return Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/D /C {check.InstallCommand}",
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
            }) ?? throw new InvalidOperationException("cmd.exe did not start.");
        }
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, $"{configuration.ApiBase}{path}");
        request.Headers.Add("X-Nemesys-API-Key", configuration.ApiKey);
        request.Headers.Add("X-Nemesys-Hostname", configuration.Hostname);
        return request;
    }

    private static TimeSpan GetPollDelay(SyncConfig? sync)
    {
        // The server still sends its effective interval for compatibility, but
        // client cadence is intentionally driven by received update-mode policy.
        var baseline = sync?.Policies.Any(policy => policy.Enabled && policy.UpdateMode) == true
            ? 30
            : 300;
        var jittered = baseline * (0.9 + Random.Shared.NextDouble() * 0.2);
        return TimeSpan.FromSeconds(jittered);
    }

    private static async Task DelayUntilNextScanAsync(
        long scanStarted,
        TimeSpan scanInterval,
        CancellationToken cancellationToken)
    {
        var remaining = scanInterval - Stopwatch.GetElapsedTime(scanStarted);
        if (remaining > TimeSpan.Zero)
            await Task.Delay(remaining, cancellationToken);
    }

    private static bool IsConfiguredMatch(string observed, string expected, string? comparisonOperator)
    {
        if (string.IsNullOrWhiteSpace(observed) || string.IsNullOrWhiteSpace(expected))
            return false;

        var comparison = comparisonOperator ?? "=";
        if (comparison == "=")
            return string.Equals(observed, expected, StringComparison.Ordinal);

        if (comparison is not ("<" or "<=" or ">=" or ">") ||
            !TryCompareDottedNumericVersions(observed, expected, out var result))
            return false;

        return comparison switch
        {
            "<" => result < 0,
            "<=" => result <= 0,
            ">=" => result >= 0,
            ">" => result > 0,
            _ => false,
        };
    }

    private static bool TryCompareDottedNumericVersions(string observed, string expected, out int result)
    {
        result = 0;
        var observedComponents = observed.Split('.');
        var expectedComponents = expected.Split('.');
        var componentCount = Math.Max(observedComponents.Length, expectedComponents.Length);

        for (var index = 0; index < componentCount; index++)
        {
            if (!TryParseVersionComponent(
                    index < observedComponents.Length ? observedComponents[index] : "0",
                    out var observedComponent) ||
                !TryParseVersionComponent(
                    index < expectedComponents.Length ? expectedComponents[index] : "0",
                    out var expectedComponent))
                return false;

            if (observedComponent == expectedComponent) continue;
            result = observedComponent < expectedComponent ? -1 : 1;
            return true;
        }

        return true;
    }

    private static bool TryParseVersionComponent(string component, out ulong value)
    {
        value = 0;
        return component.Length > 0 &&
               component.All(char.IsAsciiDigit) &&
               ulong.TryParse(component, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }

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
    private static string DescribeExpected(string value, string kind, string? comparisonOperator)
    {
        var comparison = comparisonOperator ?? "=";
        return string.IsNullOrWhiteSpace(value)
            ? $"{comparison} expected {kind} not configured"
            : $"{comparison} {value}";
    }

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
            await PipeJsonProtocol.WriteAsync(
                pipe, new WarningMessage(applicationName, seconds, allowPostpone), connectionCancellation.Token);

            using var responseCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            responseCancellation.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, seconds) + 15));
            var response = await PipeJsonProtocol.ReadAsync<WarningResponse>(pipe, responseCancellation.Token);
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
internal enum UpdateModeExitState { None, Pending, SelfUpdateHandled, LaunchDisabled }

internal sealed class EnforcementState
{
    public Task? Task { get; set; }
    public CancellationTokenSource? Cancellation { get; set; }
    public DateTimeOffset CooldownUntil { get; set; }
    public string? Signature { get; set; }
    public bool Compliant { get; set; }
    public bool? LastObservedRunning { get; set; }
    public int Generation { get; set; }
}

internal static class UpdateModeLaunchLedger
{
    private static readonly object Gate = new();
    private static readonly string DirectoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NemesysV2");
    private static readonly string FilePath = Path.Combine(DirectoryPath, "update-mode-launch-ledger.json");

    // This ledger deliberately contains only policy IDs, opaque cycle IDs, and
    // lifecycle state; launch paths, arguments, and any client credentials are
    // never persisted here.
    public static void ObserveActive(string policyId, string cycleId, ILogger logger) =>
        Change(policyId, cycleId, logger, entry =>
        {
            if (entry.State == "unobserved")
                entry.State = "active";
            return false;
        });

    public static UpdateModeExitState ObserveExit(string policyId, string cycleId, ILogger logger) =>
        Change(policyId, cycleId, logger, entry =>
        {
            if (entry.State == "active")
            {
                entry.State = "pending";
                return UpdateModeExitState.Pending;
            }
            // Once a self-update is attempted or completed, its launch
            // decision permanently owns this cycle. Pending remains eligible
            // for a later session; launch-disabled explicitly returns ordinary
            // enforcement to the policy.
            return entry.State switch
            {
                "pending" => UpdateModeExitState.Pending,
                "attempted" or "completed" => UpdateModeExitState.SelfUpdateHandled,
                "launch-disabled" => UpdateModeExitState.LaunchDisabled,
                _ => UpdateModeExitState.None,
            };
        });

    public static void MarkLaunchDisabled(string policyId, string cycleId, ILogger logger) =>
        Change(policyId, cycleId, logger, entry =>
        {
            if (entry.State == "pending")
                entry.State = "launch-disabled";
            return false;
        });

    public static bool Attempt(string policyId, string cycleId, string reason, ILogger logger) =>
        Change(policyId, cycleId, logger, entry =>
        {
            if (entry.State != "pending") return false;
            entry.State = "attempted";
            entry.Outcome = reason;
            return true;
        });

    public static void Complete(string policyId, string cycleId, string reason, ILogger logger) =>
        Change(policyId, cycleId, logger, entry =>
        {
            if (entry.State is "pending" or "active")
            {
                entry.State = "completed";
                entry.Outcome = reason;
            }
            return false;
        });

    public static void CleanReceivedPolicies(IEnumerable<string> receivedPolicyIds, ILogger logger)
    {
        var received = new HashSet<string>(receivedPolicyIds, StringComparer.OrdinalIgnoreCase);
        lock (Gate)
        {
            var ledger = Load(logger);
            if (ledger is null) return;
            if (ledger.Entries.RemoveAll(entry => !received.Contains(entry.PolicyId)) > 0)
                Save(ledger, logger);
        }
    }

    private static T Change<T>(string policyId, string cycleId, ILogger logger, Func<LedgerEntry, T> change, T failure = default!)
    {
        lock (Gate)
        {
            var ledger = Load(logger);
            if (ledger is null) return failure;
            var entry = ledger.Entries.FirstOrDefault(item =>
                item.PolicyId.Equals(policyId, StringComparison.OrdinalIgnoreCase) &&
                item.CycleId.Equals(cycleId, StringComparison.Ordinal));
            if (entry is null)
            {
                entry = new LedgerEntry { PolicyId = policyId, CycleId = cycleId, State = "unobserved" };
                ledger.Entries.Add(entry);
            }
            var result = change(entry);
            // An attempt becomes eligible only after this replacement has
            // completed. A persistence failure therefore fails closed before
            // CreateProcessAsUser can be reached.
            if (!Save(ledger, logger)) return failure;
            return result;
        }
    }

    private static LedgerFile? Load(ILogger logger)
    {
        try
        {
            if (!File.Exists(FilePath)) return new LedgerFile();
            var ledger = JsonSerializer.Deserialize<LedgerFile>(File.ReadAllText(FilePath), JsonOptions.Default);
            if (ledger?.Entries is null ||
                ledger.Entries.Any(entry =>
                    string.IsNullOrWhiteSpace(entry.PolicyId) ||
                    string.IsNullOrWhiteSpace(entry.CycleId) ||
                    entry.State is not ("unobserved" or "active" or "pending" or "attempted" or "completed" or "launch-disabled")))
                throw new InvalidDataException("The update-mode launch ledger is invalid.");
            return ledger;
        }
        catch (Exception exception)
        {
            // Failing closed is essential: treating unreadable/corrupt history
            // as empty could convert an old cycle into a duplicate launch.
            logger.LogError(exception, "Unable to read update-mode launch ledger; update-mode exit launches are suppressed");
            return null;
        }
    }

    private static bool Save(LedgerFile ledger, ILogger logger)
    {
        string? temporary = null;
        try
        {
            Directory.CreateDirectory(DirectoryPath);
            temporary = $"{FilePath}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(ledger, JsonOptions.Default));
            File.Move(temporary, FilePath, overwrite: true);
            return true;
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Unable to persist update-mode launch ledger");
            return false;
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(temporary))
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); }
                catch { /* A leftover temp file cannot authorize a launch. */ }
            }
        }
    }

    private sealed class LedgerFile { public List<LedgerEntry> Entries { get; set; } = new(); }
    private sealed class LedgerEntry
    {
        public string PolicyId { get; set; } = "";
        public string CycleId { get; set; } = "";
        public string State { get; set; } = "";
        public string? Outcome { get; set; }
    }
}

internal static class PipeJsonProtocol
{
    public static async Task WriteAsync<T>(
        Stream stream,
        T message,
        CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(message, JsonOptions.Default) + "\n";
        var bytes = Encoding.UTF8.GetBytes(payload);
        await stream.WriteAsync(bytes, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static async Task<T?> ReadAsync<T>(
        Stream stream,
        CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(
            stream,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 1024,
            leaveOpen: true);
        var line = await reader.ReadLineAsync(cancellationToken);
        return line is null ? default : JsonSerializer.Deserialize<T>(line, JsonOptions.Default);
    }
}

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

    public static bool IsExecutableRunningInSession(string executable, int sessionId)
    {
        var fullPath = Path.GetFullPath(executable);
        return Process.GetProcesses().Any(process =>
        {
            try
            {
                return process.SessionId == sessionId &&
                    string.Equals(Path.GetFullPath(process.MainModule?.FileName ?? ""), fullPath,
                        StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
            finally { process.Dispose(); }
        });
    }

    public static bool LaunchExecutable(int sessionId, string executable, string? arguments, ILogger logger)
    {
        if (!Path.IsPathFullyQualified(executable) || !File.Exists(executable))
            return false;
        if (!WTSQueryUserToken((uint)sessionId, out var userToken))
        {
            logger.LogWarning("Unable to obtain active session user token for update-mode exit launch ({Error})", Marshal.GetLastWin32Error());
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
            // applicationName is the configured full path; arguments are passed
            // directly, never interpreted by cmd.exe.
            var commandLine = new StringBuilder($"\"{executable}\"");
            if (!string.IsNullOrWhiteSpace(arguments)) commandLine.Append(' ').Append(arguments);
            if (!CreateProcessAsUser(primaryToken, executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CreateUnicodeEnvironment, environment, Path.GetDirectoryName(executable), ref startup, out var process))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return true;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Unable to launch configured update-mode exit executable in session {SessionId}", sessionId);
            return false;
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            CloseHandle(userToken);
        }
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
            var warning = await PipeJsonProtocol.ReadAsync<WarningMessage>(pipe, CancellationToken.None);
            if (warning is null) return;

            using var form = new NoActivateForm
            {
                Width = 600, Height = 270, Text = "NemesysV2 update notice",
                StartPosition = FormStartPosition.CenterScreen, TopMost = true,
                ShowInTaskbar = true,
                FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false,
                MinimizeBox = false, ControlBox = false, BackColor = Color.White,
            };
            form.Shown += (_, _) =>
            {
                PromoteToForeground(form);
                form.BeginInvoke(new Action(
                    () => PromoteToForeground(form)));
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
                PromoteToForeground(form);
                remaining--;
                countdown.Text = $"Closing in {TimeSpan.FromSeconds(Math.Max(0, remaining)):mm\\:ss}";
                if (remaining <= 0) { timer.Stop(); form.Close(); }
            };

            WinEventDelegate foregroundChanged = (_, eventType, windowHandle, _, _, _, _) =>
            {
                if (eventType != EventSystemForeground
                    || windowHandle == IntPtr.Zero
                    || form.IsDisposed
                    || windowHandle == form.Handle)
                {
                    return;
                }

                try
                {
                    form.BeginInvoke(new Action(
                        () => PromoteToForeground(form)));
                }
                catch (InvalidOperationException)
                {
                    // The form closed while a foreground event was being delivered.
                }
            };
            var foregroundHook = SetWinEventHook(
                EventSystemForeground,
                EventSystemForeground,
                IntPtr.Zero,
                foregroundChanged,
                0,
                0,
                WinEventOutOfContext | WinEventSkipOwnProcess);

            try
            {
                timer.Start();
                Application.Run(form);
            }
            finally
            {
                timer.Stop();
                if (foregroundHook != IntPtr.Zero)
                {
                    UnhookWinEvent(foregroundHook);
                }
                GC.KeepAlive(foregroundChanged);
            }
            await PipeJsonProtocol.WriteAsync(pipe, new WarningResponse(postponed), CancellationToken.None);
        }
        catch (Exception exception) when (exception is OperationCanceledException or TimeoutException or IOException or JsonException or ObjectDisposedException)
        {
            // The service treats an unavailable companion as fail-safe. IPC
            // shutdown must not turn the interactive helper into a crashed process.
        }
    }

    private const uint EventSystemForeground = 0x0003;
    private const uint WinEventOutOfContext = 0x0000;
    private const uint WinEventSkipOwnProcess = 0x0002;

    private static void PromoteToForeground(Form form)
    {
        if (form.IsDisposed || !form.IsHandleCreated) return;

        // Topmost windows still compete within their own z-order. Re-promote without
        // activation so the user can keep typing in the application being closed.
        // Exclusive-fullscreen applications remain OS-controlled.
        TopmostWindow.Pin(form.Handle);
    }

    private delegate void WinEventDelegate(
        IntPtr hook,
        uint eventType,
        IntPtr windowHandle,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr eventHookModule,
        WinEventDelegate callback,
        uint processId,
        uint threadId,
        uint flags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);

}

internal sealed class NoActivateForm : Form
{
    private const int WindowExNoActivate = 0x08000000;
    private const int WindowExAppWindow = 0x00040000;

    protected override bool ShowWithoutActivation => true;

    protected override void OnHandleCreated(EventArgs eventArgs)
    {
        base.OnHandleCreated(eventArgs);
        TopmostWindow.Pin(Handle);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= WindowExNoActivate | WindowExAppWindow;
            return parameters;
        }
    }
}

internal static class TopmostWindow
{
    private static readonly IntPtr HwndTopmost = new(-1);
    private static readonly IntPtr HwndNotTopmost = new(-2);
    private const uint SetWindowPosNoSize = 0x0001;
    private const uint SetWindowPosNoMove = 0x0002;
    private const uint SetWindowPosNoActivate = 0x0010;
    private const uint SetWindowPosShowWindow = 0x0040;
    private const uint PinFlags =
        SetWindowPosNoMove
        | SetWindowPosNoSize
        | SetWindowPosNoActivate
        | SetWindowPosShowWindow;

    public static void Pin(IntPtr windowHandle)
    {
        // NOACTIVATE windows do not receive the normal activation-driven z-order
        // refresh, so force one by toggling out of and back into the topmost band.
        SetWindowPos(windowHandle, HwndNotTopmost, 0, 0, 0, 0, PinFlags);
        SetWindowPos(windowHandle, HwndTopmost, 0, 0, 0, 0, PinFlags);
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr windowHandle,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);
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
    List<SoftwarePolicy> Policies);
internal sealed record SoftwarePolicy(
    string Id,
    string Name,
    string Executable,
    string TargetVersion,
    List<string> SupervisedExecutables,
    List<ExeCheck> ExeChecks,
    List<IniCheck> IniChecks,
    bool UpdateMode = false,
    int NormalCloseTimeoutSeconds = 30,
    int UpdateModeCloseTimeoutSeconds = 8,
    bool LaunchOnExitUpdateMode = false,
    string? LaunchExecutablePath = null,
    string? LaunchArguments = null,
    string? UpdateModeCycleId = null,
    bool AllowPostpone = false,
    bool Enabled = true);
internal sealed record ExeCheck(
    string Executable,
    string TargetVersion,
    string? InstallCommand,
    string? ComparisonOperator = null);
internal sealed record IniCheck(
    string FilePath,
    string Section,
    string Key,
    string ExpectedValue,
    string? ComparisonOperator = null);
internal sealed record ApplicationResult(
    string SoftwareId,
    string SoftwareName,
    bool Compliant,
    string ObservedVersion,
    string ExpectedVersion);