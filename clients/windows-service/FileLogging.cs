using Microsoft.Extensions.Logging;

namespace NemesysV2.Client;

internal sealed class DailyFileLoggerProvider : ILoggerProvider
{
    private readonly object gate = new();
    private readonly string directory;
    private StreamWriter? writer;
    private DateTime writerDate;

    public DailyFileLoggerProvider(string directory)
    {
        this.directory = directory;
        Directory.CreateDirectory(directory);
        DeleteLogsExcept(DateTime.Now.Date);
    }

    public ILogger CreateLogger(string categoryName) =>
        new DailyFileLogger(this, categoryName);

    public void Dispose()
    {
        lock (gate)
        {
            writer?.Dispose();
            writer = null;
        }
    }

    internal void Write(
        string categoryName,
        LogLevel logLevel,
        EventId eventId,
        string message,
        Exception? exception)
    {
        lock (gate)
        {
            var now = DateTime.Now;
            if (writer is null || writerDate.Date != now.Date)
            {
                writer?.Dispose();
                DeleteLogsExcept(now.Date);
                writerDate = now.Date;
                var path = Path.Combine(directory, $"client-{now:yyyyMMdd}.log");
                writer = new StreamWriter(new FileStream(
                    path,
                    FileMode.Append,
                    FileAccess.Write,
                    FileShare.ReadWrite))
                {
                    AutoFlush = true,
                };
            }

            writer.WriteLine(
                $"{now:O} [{logLevel}] {categoryName} (EventId={eventId.Id}): {message}");
            if (exception is not null)
                writer.WriteLine(exception);
        }
    }

    private void DeleteLogsExcept(DateTime currentDate)
    {
        foreach (var path in Directory.EnumerateFiles(directory, "client-*.log"))
        {
            var fileName = Path.GetFileNameWithoutExtension(path);
            if (!fileName.StartsWith("client-", StringComparison.OrdinalIgnoreCase) ||
                !DateTime.TryParseExact(
                    fileName["client-".Length..],
                    "yyyyMMdd",
                    null,
                    System.Globalization.DateTimeStyles.None,
                    out var fileDate) ||
                fileDate.Date == currentDate)
                continue;

            try
            {
                File.Delete(path);
            }
            catch (IOException)
            {
                // A transient lock is safe; the next startup or rollover retries it.
            }
            catch (UnauthorizedAccessException)
            {
                // A transient file-attribute or permission issue is safe to retry later.
            }
        }
    }
}

internal sealed class DailyFileLogger(
    DailyFileLoggerProvider provider,
    string categoryName) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull =>
        NullScope.Instance;

    public bool IsEnabled(LogLevel logLevel) =>
        logLevel >= LogLevel.Information;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
            return;

        provider.Write(categoryName, logLevel, eventId, formatter(state, exception), exception);
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose() { }
    }
}