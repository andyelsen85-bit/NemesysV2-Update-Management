using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace NemesysV2.Client;

internal sealed class SyncWorker(ClientConfiguration configuration, ILogger<SyncWorker> logger) : BackgroundService
{
    private readonly HttpClient http = new();
    private string? clientId;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                clientId ??= await EnrollAsync(stoppingToken);
                var sync = await GetSyncConfigAsync(clientId, stoppingToken);
                await EvaluateAndReportAsync(sync, stoppingToken);
                await Task.Delay(TimeSpan.FromSeconds(Math.Max(10, sync.SyncIntervalSeconds)), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "NemesysV2 synchronization failed");
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
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

    private async Task<SyncConfig> GetSyncConfigAsync(string id, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Get, $"/sync/config?clientId={Uri.EscapeDataString(id)}");
        using var response = await http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<SyncConfig>(JsonOptions.Default, cancellationToken)
            ?? throw new InvalidOperationException("Sync configuration response was empty.");
    }

    private async Task EvaluateAndReportAsync(SyncConfig sync, CancellationToken cancellationToken)
    {
        var results = sync.Policies.Select(EvaluatePolicy).ToList();
        var nonCompliant = results.Any(result => !result.Compliant);
        if (nonCompliant)
        {
            await SessionWarningChannel.SendAsync(
                $"NemesysV2 will close managed applications in {sync.CloseOnStartTimeoutSeconds} seconds.",
                sync.CloseOnStartTimeoutSeconds,
                cancellationToken);
            await Task.Delay(TimeSpan.FromSeconds(sync.CloseOnStartTimeoutSeconds), cancellationToken);
            CloseManagedProcesses(sync.Policies);
            RunSilentInstallCommands(sync.Policies);
        }

        using var request = CreateRequest(HttpMethod.Post, "/sync/report");
        request.Content = JsonContent.Create(new
        {
            clientId,
            clientName = configuration.Hostname,
            result = nonCompliant ? "warning" : "success",
            applications = results,
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
            return observed == check.TargetVersion;
        });
        var iniResults = policy.IniChecks.Select(check =>
            ReadIniValue(check.FilePath, check.Section, check.Key) == check.ExpectedValue);
        var checks = exeResults.Concat(iniResults).ToList();
        return new ApplicationResult(policy.Id, policy.Name, checks.All(value => value), policy.TargetVersion, policy.TargetVersion);
    }

    private void CloseManagedProcesses(IEnumerable<SoftwarePolicy> policies)
    {
        var processNames = policies
            .SelectMany(policy => policy.ExeChecks)
            .Select(check => Path.GetFileNameWithoutExtension(check.Executable))
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
    public static async Task SendAsync(string message, int seconds, CancellationToken cancellationToken)
    {
        try
        {
            await using var pipe = new NamedPipeClientStream(".", "NemesysV2.UserSession", PipeDirection.Out, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(1000, cancellationToken);
            await JsonSerializer.SerializeAsync(pipe, new WarningMessage(message, seconds), JsonOptions.Default, cancellationToken);
        }
        catch (TimeoutException) { }
        catch (IOException) { }
    }
}

internal sealed class SessionCompanion
{
    public static async Task RunAsync()
    {
        while (true)
        {
            await using var pipe = new NamedPipeServerStream("NemesysV2.UserSession", PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            await pipe.WaitForConnectionAsync();
            var warning = await JsonSerializer.DeserializeAsync<WarningMessage>(pipe, JsonOptions.Default);
            if (warning is null) continue;

            using var form = new Form
            {
                Width = 520,
                Height = 170,
                Text = "NemesysV2 update notice",
                StartPosition = FormStartPosition.CenterScreen,
                TopMost = true,
            };
            var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12), Text = warning.Message };
            form.Controls.Add(label);
            using var timer = new System.Windows.Forms.Timer { Interval = 1000 };
            var remaining = warning.Seconds;
            timer.Tick += (_, _) =>
            {
                remaining--;
                label.Text = $"{warning.Message}\r\n\r\n{remaining} seconds remaining";
                if (remaining <= 0) { timer.Stop(); form.Close(); }
            };
            timer.Start();
            Application.Run(form);
        }
    }
}

internal sealed record WarningMessage(string Message, int Seconds);
internal sealed record ClientResponse(string Id);
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
    List<ExeCheck> ExeChecks,
    List<IniCheck> IniChecks);
internal sealed record ExeCheck(string Executable, string TargetVersion, string? InstallCommand);
internal sealed record IniCheck(string FilePath, string Section, string Key, string ExpectedValue);
internal sealed record ApplicationResult(
    string SoftwareId,
    string SoftwareName,
    bool Compliant,
    string ObservedVersion,
    string ExpectedVersion);