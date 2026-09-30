using System;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using static Shotx.Tests.TestSupport;

namespace Shotx.Tests
{
    [TestFixture]
    public class SxClientTests
    {
        private TestServer _server;
        private SxClient _client;

        [OneTimeSetUp]
        public void StartServer() => _server = new TestServer();

        [OneTimeTearDown]
        public void StopServer() => _server.Dispose();

        [TearDown]
        public void DisposeClient()
        {
            _client?.Dispose();
            _client = null;
        }

        [Test]
        public async Task Connect_ResolvesWithAuthData()
        {
            var auth = await Client().Connect("valid");

            Assert.That((string)auth["userId"], Is.EqualTo("user123"));
            Assert.That(_client.IsConnected, Is.True);
        }

        [Test]
        public void Connect_RejectsInvalidToken()
        {
            var error = Assert.ThrowsAsync<SxException>(() => Client().Connect("invalid"));

            Assert.That(error.Code, Is.EqualTo("AUTH_FAIL"));
            Assert.That(_client.IsConnected, Is.False);
        }

        [Test]
        public async Task Send_ResolvesWithHandlerResult()
        {
            await Client().Connect("valid");

            var result = await _client.Send("echo", new { count = 3 });

            Assert.That((int)result["data"]["count"], Is.EqualTo(3));
            Assert.That((string)result["meta"]["type"], Is.EqualTo("echo"));
            Assert.That((string)result["meta"]["id"], Does.Match("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"));
        }

        [Test]
        public async Task Send_RejectsUnknownType()
        {
            await Client().Connect("valid");

            var error = Assert.ThrowsAsync<SxException>(() => _client.Send("missing"));

            Assert.That(error.Code, Is.EqualTo("2003"));
        }

        [Test]
        public async Task Send_RejectsWithHandlerError()
        {
            await Client().Connect("valid");

            var error = Assert.ThrowsAsync<SxException>(() => _client.Send("fail"));

            Assert.That(error.Code, Is.EqualTo("2004"));
            Assert.That(error.Message, Is.EqualTo("handler failed"));
        }

        [Test]
        public async Task Send_TimesOut()
        {
            await Client().Connect("valid");

            Assert.ThrowsAsync<TimeoutException>(() =>
                _client.Send("slow", new { ms = 1000 }, TimeSpan.FromMilliseconds(100)));
        }

        [Test]
        public async Task Send_BeforeConnect_IsDeliveredAfterConnect()
        {
            var pending = Client().Send("echo", "queued");
            await Task.Delay(100);
            Assert.That(pending.IsCompleted, Is.False);

            await _client.Connect("valid");

            Assert.That((string)(await pending)["data"], Is.EqualTo("queued"));
        }

        [Test]
        public async Task Join_ReceivesRoomMessages()
        {
            var received = Received(Client(), "notice");
            await _client.Connect("valid");
            await _client.Join("room-live");

            await _client.Send("broadcast", new { room = "room-live", type = "notice", data = new { text = "hi" } });

            var (data, meta) = await WithPatience(received);
            Assert.That((string)data["text"], Is.EqualTo("hi"));
            Assert.That((string)meta["type"], Is.EqualTo("notice"));
        }

        [Test]
        public async Task OnMessage_PreservesArrivalOrder()
        {
            // Without a captured context, handlers start inline in the transport's arrival order.
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                Client();
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }
            var received = new System.Collections.Generic.List<int>();
            _client.OnMessage("tick", (data, meta) =>
            {
                lock (received) received.Add((int)data);
            });
            await _client.Connect("valid");
            await _client.Join("room-order");

            await _client.Send("burst", new { room = "room-order", type = "tick", count = 200 });

            await WaitUntil(() => { lock (received) return received.Count == 200; });
            Assert.That(received, Is.EqualTo(System.Linq.Enumerable.Range(0, 200)));
        }

        [Test]
        public async Task Join_ReceivesMessagesSentWhileRoomWasEmpty()
        {
            var received = Received(Client(), "notice");
            await _client.Connect("valid");
            await _client.Send("broadcast", new { room = "room-empty", type = "notice", data = "stored" });

            await _client.Join("room-empty");

            Assert.That((string)(await WithPatience(received)).Data, Is.EqualTo("stored"));
        }

        [Test]
        public async Task Reconnect_FlushesQueueAndRejoinsRooms()
        {
            var received = Received(Client(new SxClientOptions { ReconnectionDelay = 100, ReconnectionDelayMax = 200 }), "notice");
            await _client.Connect("valid");
            await _client.Join("room-resume");

            await _client.Send("drop", new { blockMs = 500 });
            await WaitUntil(() => !_client.IsConnected);
            var pending = _client.Send("echo", "while-offline");
            await Task.Delay(100);
            Assert.That(pending.IsCompleted, Is.False);

            Assert.That((string)(await WithPatience(pending))["data"], Is.EqualTo("while-offline"));
            await _client.Send("broadcast", new { room = "room-resume", type = "notice", data = "after-reconnect" });
            Assert.That((string)(await WithPatience(received)).Data, Is.EqualTo("after-reconnect"));
        }

        [Test]
        public async Task OnMessage_RunsHandlersOnCapturedContext()
        {
            var context = new RecordingContext();
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(context);
            try
            {
                Client();
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }

            var handled = new TaskCompletionSource<SynchronizationContext>(TaskCreationOptions.RunContinuationsAsynchronously);
            _client.OnMessage("notice", (data, meta) => handled.TrySetResult(SynchronizationContext.Current));
            await _client.Connect("valid");
            await _client.Join("room-context");

            await _client.Send("broadcast", new { room = "room-context", type = "notice", data = 1 });

            Assert.That(await WithPatience(handled.Task), Is.SameAs(context));
        }

        private SxClient Client(SxClientOptions options = null)
        {
            options ??= new SxClientOptions();
            options.Timeout = Patience;
            _client = new SxClient(_server.Url, options);
            return _client;
        }

        private sealed class RecordingContext : SynchronizationContext
        {
            public override void Post(SendOrPostCallback callback, object state)
            {
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    SetSynchronizationContext(this);
                    callback(state);
                });
            }
        }
    }
}
