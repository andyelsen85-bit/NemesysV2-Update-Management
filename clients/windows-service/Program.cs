using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;

namespace NemesysV2.Client;

internal static class Program
{
    public static async Task Main(string[] args)
    {
        if (args.Any(arg => arg.Equals("--session-companion", StringComparison.OrdinalIgnoreCase)))
        {
            await SessionCompanion.RunAsync();
            return;
        }

        if (args.Any(arg => arg.Equals("/uninstall", StringComparison.OrdinalIgnoreCase)))
        {
            ClientConfiguration.Uninstall();
            return;
        }

        if (args.Any(arg => arg.Equals("/prepare-msi", StringComparison.OrdinalIgnoreCase)))
        {
            ClientConfiguration.PrepareMsiService();
            return;
        }

        if (args.Any(arg => arg.Equals("/configure", StringComparison.OrdinalIgnoreCase)))
        {
            ClientConfiguration.Configure(args);
            return;
        }

        if (args.Any(arg => arg.Equals("/quiet", StringComparison.OrdinalIgnoreCase) ||
                            arg.Equals("/install", StringComparison.OrdinalIgnoreCase)))
        {
            ClientConfiguration.Install(args);
            return;
        }

        var configuration = ClientConfiguration.Load();
        var builder = Host.CreateApplicationBuilder(args);
        builder.Logging.AddProvider(new DailyFileLoggerProvider(
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "NemesysV2",
                "logs")));
        builder.Services.AddSingleton(configuration);
        builder.Services.AddHostedService<SyncWorker>();
        builder.Services.AddWindowsService(options => options.ServiceName = "NemesysV2 Client");
        await builder.Build().RunAsync();
    }
}

internal sealed class ClientConfiguration
{
    private static readonly string DirectoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NemesysV2");
    private static readonly string FilePath = Path.Combine(DirectoryPath, "client.json");
    private static readonly string LegacyTaskPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        "System32",
        "Tasks",
        "NemesysV2 User Session");

    public string Server { get; init; } = "";
    public int Port { get; init; } = 443;
    public string EncryptedApiKey { get; init; } = "";
    public string Hostname { get; init; } = Environment.MachineName;
    public int SyncIntervalSeconds { get; init; } = 300;

    [JsonIgnore]
    public string ApiKey => DpapiSecretStore.Unprotect(EncryptedApiKey);

    [JsonIgnore]
    public string ApiBase
    {
        get
        {
            if (!Uri.TryCreate(Server, UriKind.Absolute, out var baseUri) ||
                (baseUri.Scheme != Uri.UriSchemeHttp && baseUri.Scheme != Uri.UriSchemeHttps))
            {
                throw new InvalidOperationException(
                    "The configured server must be an absolute URL beginning with http:// or https://.");
            }

            var uri = new UriBuilder(baseUri)
            {
                Port = Port,
                Path = $"{baseUri.AbsolutePath.TrimEnd('/')}/api",
            };
            return uri.Uri.AbsoluteUri.TrimEnd('/');
        }
    }

    public static ClientConfiguration Load()
    {
        if (!File.Exists(FilePath))
            throw new InvalidOperationException($"NemesysV2 client configuration was not found at {FilePath}.");

        var configuration = JsonSerializer.Deserialize<ClientConfiguration>(
            File.ReadAllText(FilePath), JsonOptions.Default);
        if (configuration is null)
            throw new InvalidOperationException("NemesysV2 client configuration is invalid.");

        Save(configuration);
        return configuration;
    }

    public static void Install(string[] args)
    {
        Configure(args);

        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Installer executable path is unavailable.");
        StopAndDeleteService();
        Run("sc.exe", $"create NemesysV2Client binPath= \"{executable}\" start= auto obj= LocalSystem");
        Run("sc.exe", "description NemesysV2Client \"NemesysV2 Windows software update client\"");
        Run("sc.exe", "start NemesysV2Client");
    }

    public static void Configure(string[] args)
    {
        var server = GetArgument(args, "/server");
        var apiKey = GetArgument(args, "/apiKey");
        var portText = GetArgument(args, "/port");
        if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(apiKey))
            throw new ArgumentException("Silent installation requires /server and /apiKey.");

        Directory.CreateDirectory(DirectoryPath);
        var configuration = new ClientConfiguration
        {
            Server = server,
            Port = int.TryParse(portText, out var port) ? port : 443,
            EncryptedApiKey = DpapiSecretStore.Protect(apiKey),
            Hostname = Environment.MachineName,
        };
        Save(configuration);
        // Older builds used a LocalSystem ONLOGON task for the interactive
        // companion. Services cannot display on the user's desktop, and a task
        // created by LocalSystem does not solve that problem. Warnings now
        // launch a short-lived companion in the active user's session.
        DeleteLegacyScheduledTask();
    }

    public static void PrepareMsiService() => StopAndDeleteService();

    public static void Uninstall()
    {
        StopAndDeleteService();
        DeleteLegacyScheduledTask();
        DeleteDataDirectory();
    }

    private static void DeleteLegacyScheduledTask()
    {
        if (!File.Exists(LegacyTaskPath)) return;

        Run("schtasks.exe", "/Delete /TN \"NemesysV2 User Session\" /F");
        if (File.Exists(LegacyTaskPath))
            throw new IOException("The obsolete NemesysV2 user-session task was not deleted.");
    }

    private static void Save(ClientConfiguration configuration)
    {
        Directory.CreateDirectory(DirectoryPath);
        var temporaryPath = $"{FilePath}.tmp";
        File.WriteAllText(
            temporaryPath,
            JsonSerializer.Serialize(configuration, JsonOptions.Default));
        File.Move(temporaryPath, FilePath, overwrite: true);
    }

    private static void StopAndDeleteService()
    {
        var serviceExecutablePath = GetRegisteredServiceExecutablePath() ?? Environment.ProcessPath;
        Run("sc.exe", "stop NemesysV2Client", throwOnError: false);
        Run("sc.exe", "delete NemesysV2Client", throwOnError: false);
        WaitForServiceDeletion(TimeSpan.FromSeconds(30));
        WaitForClientProcessesToExit(serviceExecutablePath, TimeSpan.FromSeconds(30));
    }

    private static string? GetRegisteredServiceExecutablePath()
    {
        using var serviceKey = Registry.LocalMachine.OpenSubKey(
            @"SYSTEM\CurrentControlSet\Services\NemesysV2Client");
        var rawImagePath = serviceKey?.GetValue("ImagePath") as string;
        if (string.IsNullOrWhiteSpace(rawImagePath)) return null;

        var imagePath = Environment.ExpandEnvironmentVariables(rawImagePath).Trim();
        if (imagePath.StartsWith('"'))
        {
            var closingQuote = imagePath.IndexOf('"', 1);
            return closingQuote > 1 ? imagePath[1..closingQuote] : null;
        }

        var executableEnd = imagePath.IndexOf(
            ".exe",
            StringComparison.OrdinalIgnoreCase);
        return executableEnd >= 0 ? imagePath[..(executableEnd + 4)] : imagePath;
    }

    private static void WaitForServiceDeletion(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var query = RunAndCapture("sc.exe", "query NemesysV2Client");
            if (query.ExitCode != 0) return;

            Thread.Sleep(500);
        }

        throw new InvalidOperationException("NemesysV2Client was not deleted.");
    }

    private static void WaitForClientProcessesToExit(
        string? executablePath,
        TimeSpan timeout)
    {
        if (string.IsNullOrWhiteSpace(executablePath)) return;

        var processName = Path.GetFileNameWithoutExtension(executablePath);
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var otherClientProcessFound = false;
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    if (process.Id == Environment.ProcessId) continue;
                    var processPath = process.MainModule?.FileName;
                    if (string.Equals(processPath, executablePath, StringComparison.OrdinalIgnoreCase))
                    {
                        otherClientProcessFound = true;
                        break;
                    }
                }
                catch (InvalidOperationException)
                {
                    otherClientProcessFound = true;
                    break;
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    otherClientProcessFound = true;
                    break;
                }
                finally
                {
                    process.Dispose();
                }
            }

            if (!otherClientProcessFound) return;
            Thread.Sleep(500);
        }

        throw new InvalidOperationException(
            "The NemesysV2 client process did not exit before uninstall cleanup.");
    }

    private static void DeleteDataDirectory()
    {
        if (!Directory.Exists(DirectoryPath)) return;

        Exception? lastError = null;
        for (var attempt = 0; attempt < 60; attempt++)
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
                return;
            }
            catch (Exception exception) when (
                exception is IOException or UnauthorizedAccessException)
            {
                lastError = exception;
                Thread.Sleep(1000);
            }
        }

        throw new IOException(
            $"Unable to remove NemesysV2 client data at {DirectoryPath}.",
            lastError);
    }

    private static string GetArgument(string[] args, string name)
    {
        var index = Array.FindIndex(args, arg => arg.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1].Trim('"') : "";
    }

    private static void Run(string fileName, string arguments, bool throwOnError = true)
    {
        var result = RunAndCapture(fileName, arguments);
        if (throwOnError && result.ExitCode != 0)
            throw new InvalidOperationException(
                $"{fileName} failed with exit code {result.ExitCode}: {result.Output}");
    }

    private static ProcessResult RunAndCapture(string fileName, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException($"Unable to start {fileName}.");
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return new ProcessResult(
            process.ExitCode,
            $"{standardOutput}{Environment.NewLine}{standardError}".Trim());
    }

    private sealed record ProcessResult(int ExitCode, string Output);
}

internal static class DpapiSecretStore
{
    public static string Protect(string value) =>
        Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.LocalMachine));

    public static string Unprotect(string value) =>
        Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value), null, DataProtectionScope.LocalMachine));
}

internal static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };
}