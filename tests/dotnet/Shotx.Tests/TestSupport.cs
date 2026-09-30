using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Shotx.Tests
{
    internal sealed class TestServer : IDisposable
    {
        private readonly Process _process;

        public TestServer(string mode = null)
        {
            var script = Path.Combine(TestDirectory(), "server.mjs");
            _process = Process.Start(new ProcessStartInfo("node", mode == null ? script : $"{script} {mode}")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false
            });
            var port = _process.StandardOutput.ReadLine();
            Assert.That(port, Does.Match(@"^\d+$"), "test server did not report its port");
            Url = $"http://localhost:{port}";
        }

        public string Url { get; }

        public void Dispose()
        {
            _process.Kill();
            _process.Dispose();
        }

        private static string TestDirectory([CallerFilePath] string path = null) => Path.GetDirectoryName(path);
    }

    internal static class TestSupport
    {
        public static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

        public static Task<(JToken Data, JObject Meta)> Received(SxClient client, string route)
        {
            var received = new TaskCompletionSource<(JToken, JObject)>(TaskCreationOptions.RunContinuationsAsynchronously);
            client.OnMessage(route, (data, meta) => received.TrySetResult((data, meta)));
            return received.Task;
        }

        public static async Task<T> WithPatience<T>(Task<T> task)
        {
            if (await Task.WhenAny(task, Task.Delay(Patience)) != task) Assert.Fail("timed out waiting for result");
            return await task;
        }

        public static async Task WaitUntil(Func<bool> condition)
        {
            var deadline = DateTime.UtcNow + Patience;
            while (!condition())
            {
                if (DateTime.UtcNow >= deadline) Assert.Fail("timed out waiting for condition");
                await Task.Delay(10);
            }
        }
    }
}
