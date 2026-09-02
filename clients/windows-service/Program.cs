using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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

        if (args.Any(arg => arg.Equals("/quiet", StringComparison.OrdinalIgnoreCase) ||
                            arg.Equals("/install", StringComparison.OrdinalIgnoreCase)))
        {
            ClientConfiguration.Install(args);
            return;
        }

        var configuration = ClientConfiguration.Load();
        var builder = Host.CreateApplicationBuilder(args);
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

    public string Server { get; init; } = "";
    public int Port { get; init; } = 5187;
    public string EncryptedApiKey { get; init; } = "";
    public string Hostname { get; init; } = Environment.MachineName;
    public int SyncIntervalSeconds { get; init; } = 300;

    public string ApiKey => DpapiSecretStore.Unprotect(EncryptedApiKey);
    public string ApiBase => $"{Server.TrimEnd('/')}/api";

    public static ClientConfiguration Load()
    {
        if (!File.Exists(FilePath))
            throw new InvalidOperationException($"NemesysV2 client configuration was not found at {FilePath}.");

        var configuration = JsonSerializer.Deserialize<ClientConfiguration>(
            File.ReadAllText(FilePath), JsonOptions.Default);
        return configuration ?? throw new InvalidOperationException("NemesysV2 client configuration is invalid.");
    }

    public static void Install(string[] args)
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
            Port = int.TryParse(portText, out var port) ? port : 5187,
            EncryptedApiKey = DpapiSecretStore.Protect(apiKey),
            Hostname = Environment.MachineName,
        };
        File.WriteAllText(FilePath, JsonSerializer.Serialize(configuration, JsonOptions.Default));

        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Installer executable path is unavailable.");
        Run("sc.exe", $"create NemesysV2Client binPath= \"{executable}\" start= auto obj= LocalSystem");
        Run("sc.exe", "description NemesysV2Client \"NemesysV2 Windows software update client\"");
        Run("schtasks.exe", $"/Create /TN \"NemesysV2 User Session\" /SC ONLOGON /TR \"\\\"{executable}\\\" --session-companion\" /RL LIMITED /F");
        Run("sc.exe", "start NemesysV2Client");
    }

    private static string GetArgument(string[] args, string name)
    {
        var index = Array.FindIndex(args, arg => arg.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1].Trim('"') : "";
    }

    private static void Run(string fileName, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        }) ?? throw new InvalidOperationException($"Unable to start {fileName}.");
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{fileName} failed with exit code {process.ExitCode}.");
    }
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