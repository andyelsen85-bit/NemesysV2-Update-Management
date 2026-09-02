using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
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
        request.Content = JsonContent.Create(new { address = ResolveAddress() }, options: JsonOptions.Default);
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
        if (nonCompliantPolicies.Count > 0)
        {
            foreach (var item in nonCompliantPolicies)
            {
                var timeout = item.Policy.UpdateMode
                    ? Math.Max(1, item.Policy.UpdateModeCloseTimeoutSeconds)
                    : Math.Max(5, sync.NormalCloseTimeoutSeconds);
                var postponed = await SessionWarningChannel.ShowAsync(
                    item.Policy.Name,
                    timeout,
                    item.Policy.AllowPostpone,
                    cancellationToken);
                if (postponed)
                {
                    logger.LogInformation("User postponed the controlled update for {ApplicationName}", item.Policy.Name);
                    syncEtag = null;
                    continue;
                }
                CloseManagedProcesses(new[] { item.Policy });
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
    }

    private ApplicationResult EvaluatePolicy(SoftwarePolicy policy)
    {
        var exeResults = policy.ExeChecks.Select(check =>
        {
            var observed = File.Exists(check.Executable)
                ? FileVersionInfo.GetVersionInfo(check.Executable).FileVersion ?? ""
                : "";
            return (Observed: observed, Expected: check.TargetVersion, Compliant: observed == check.TargetVersion);
        });
        var iniResults = policy.IniChecks.Select(check =>
        {
            var observed = ReadIniValue(check.FilePath, check.Section, check.Key);
            return (Observed: observed, Expected: check.ExpectedValue, Compliant: observed == check.ExpectedValue);
        });
        var checks = exeResults.Concat(iniResults).ToList();
        var first = checks.FirstOrDefault();
        return new ApplicationResult(policy.Id, policy.Name, checks.Count == 0 || checks.All(value => value.Compliant), first.Observed ?? "", first.Expected ?? "");
    }

    private void CloseManagedProcesses(IEnumerable<SoftwarePolicy> policies)
    {
        var processNames = policies
            .SelectMany(policy => policy.SupervisedExecutables.Concat(policy.ExeChecks.Select(check => check.Executable)))
            .Select(Path.GetFileNameWithoutExtension)
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase);
        foreach (var processName in processNames)
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try { process.Kill(entireProcessTree: true); }
                catch (Exception exception) { logger.LogWarning(exception, "Unable to close {ProcessName}", processName); }
                finally { process.Dispose(); }
            }
        }
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

    private static string ResolveAddress() => "windows-client";

    private static string ReadIniValue(string path, string section, string key)
    {
        if (!File.Exists(path)) return "";
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
                return value[(separator + 1)..].Trim();
        }
        return "";
    }
}

internal static class SessionWarningChannel
{
    public static async Task<bool> ShowAsync(string applicationName, int seconds, bool allowPostpone, CancellationToken cancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        using var exchangeCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        exchangeCancellation.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, seconds) + 5));
        try
        {
            await using var pipe = CreateServer();
            using var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(exchangeCancellation.Token);
            connectionCancellation.CancelAfter(TimeSpan.FromSeconds(1));
            await pipe.WaitForConnectionAsync(connectionCancellation.Token);
            var isAuthenticatedUser = false;
            pipe.RunAsClient(() =>
            {
                using var identity = WindowsIdentity.GetCurrent();
                isAuthenticatedUser = identity.IsAuthenticated && identity.User is not null &&
                    !identity.User.IsWellKnown(WellKnownSidType.AnonymousSid);
            });
            if (!isAuthenticatedUser || !IsExpectedSessionCompanion(pipe))
                throw new UnauthorizedAccessException("The pipe client is not the installed NemesysV2 session companion.");
            await JsonSerializer.SerializeAsync(pipe, new WarningMessage(applicationName, seconds, allowPostpone), JsonOptions.Default, exchangeCancellation.Token);
            await pipe.FlushAsync(exchangeCancellation.Token);
            var response = await JsonSerializer.DeserializeAsync<WarningResponse>(pipe, JsonOptions.Default, exchangeCancellation.Token);
            return allowPostpone && response?.Postponed == true;
        }
        catch (TimeoutException)
        {
            await WaitForRemainingWarningTimeAsync(startedAt, seconds, cancellationToken);
            return false;
        }
        catch (IOException)
        {
            await WaitForRemainingWarningTimeAsync(startedAt, seconds, cancellationToken);
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            await WaitForRemainingWarningTimeAsync(startedAt, seconds, cancellationToken);
            return false;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            await WaitForRemainingWarningTimeAsync(startedAt, seconds, cancellationToken);
            return false;
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

    private static bool IsExpectedSessionCompanion(NamedPipeServerStream pipe)
    {
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out var processId) ||
            processId > int.MaxValue)
            return false;

        try
        {
            using var process = Process.GetProcessById((int)processId);
            var expectedPath = Environment.ProcessPath;
            var actualPath = process.MainModule?.FileName;
            return process.SessionId != 0 &&
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

    private static async Task WaitForRemainingWarningTimeAsync(long startedAt, int seconds, CancellationToken cancellationToken)
    {
        var remaining = TimeSpan.FromSeconds(Math.Max(1, seconds)) - Stopwatch.GetElapsedTime(startedAt);
        if (remaining > TimeSpan.Zero)
            await Task.Delay(remaining, cancellationToken);
    }
}

internal sealed class SessionCompanion
{
    public static async Task RunAsync()
    {
        while (true)
        {
            await using var pipe = new NamedPipeClientStream(
                ".",
                "NemesysV2.UserSession",
                PipeDirection.InOut,
                PipeOptions.Asynchronous,
                TokenImpersonationLevel.Identification);
            try
            {
                await pipe.ConnectAsync();
            }
            catch (IOException)
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
                continue;
            }
            var warning = await JsonSerializer.DeserializeAsync<WarningMessage>(pipe, JsonOptions.Default);
            if (warning is null) continue;

            using var form = new Form
            {
                Width = 600,
                Height = 270,
                Text = "NemesysV2 update notice",
                StartPosition = FormStartPosition.CenterScreen,
                TopMost = true,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                ControlBox = false,
                BackColor = Color.White,
            };
            var title = new Label
            {
                AutoSize = false,
                Left = 28,
                Top = 24,
                Width = 530,
                Height = 32,
                Font = new Font("Segoe UI Semibold", 16),
                Text = $"{warning.ApplicationName} needs to close",
            };
            var detail = new Label
            {
                AutoSize = false,
                Left = 30,
                Top = 64,
                Width = 525,
                Height = 60,
                Font = new Font("Segoe UI", 10),
                ForeColor = Color.FromArgb(75, 85, 99),
                Text = "Maintenance is running\r\nPlease save your work. The application will close automatically so maintenance can continue.",
            };
            var countdown = new Label
            {
                AutoSize = false,
                Left = 30,
                Top = 132,
                Width = 525,
                Height = 28,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Segoe UI Semibold", 10),
                ForeColor = Color.FromArgb(153, 96, 0),
            };
            var closeButton = new Button
            {
                Width = 170,
                Height = 36,
                Left = 382,
                Top = 184,
                Text = "Close application now",
                Font = new Font("Segoe UI Semibold", 9),
                BackColor = Color.FromArgb(8, 118, 71),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            closeButton.FlatAppearance.BorderSize = 0;
            var postponed = false;
            closeButton.Click += (_, _) => form.Close();
            form.Controls.AddRange(new Control[] { title, detail, countdown, closeButton });
            if (warning.AllowPostpone)
            {
                var postponeButton = new Button
                {
                    Width = 130,
                    Height = 36,
                    Left = 242,
                    Top = 184,
                    Text = "Postpone",
                    Font = new Font("Segoe UI Semibold", 9),
                    FlatStyle = FlatStyle.System,
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
    }
}

internal sealed record WarningMessage(string ApplicationName, int Seconds, bool AllowPostpone);
internal sealed record WarningResponse(bool Postponed);
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