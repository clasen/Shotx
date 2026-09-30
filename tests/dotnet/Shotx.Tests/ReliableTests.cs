using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using static Shotx.Tests.TestSupport;

namespace Shotx.Tests
{
    [TestFixture]
    public class ReliableTests
    {
        private TestServer _server;
        private string _stateDirectory;
        private readonly List<SxClient> _clients = new List<SxClient>();

        [OneTimeSetUp]
        public void StartServer() => _server = new TestServer("reliable");

        [OneTimeTearDown]
        public void StopServer() => _server.Dispose();

        [SetUp]
        public void CreateStateDirectory()
        {
            _stateDirectory = Path.Combine(Path.GetTempPath(), "shotx-reliable-" + Guid.NewGuid());
        }

        [TearDown]
        public void DisposeClients()
        {
            foreach (var client in _clients) client.Dispose();
            _clients.Clear();
            if (Directory.Exists(_stateDirectory)) Directory.Delete(_stateDirectory, true);
        }

        [Test]
        public async Task Reconnect_ReplaysMissedRoomMessagesOnceInOrder()
        {
            var room = Room();
            var receiver = Client();
            var received = Record(receiver, "notice");
            await receiver.Connect("valid");
            await receiver.Join(room);
            var sender = await Sender();

            await Broadcast(sender, room, "m1");
            await WaitUntil(() => received.Count == 1);
            await receiver.Send("drop", new { blockMs = 500 });
            await WaitUntil(() => !receiver.IsConnected);
            await Broadcast(sender, room, "m2");
            await Broadcast(sender, room, "m3");

            await WaitUntil(() => received.Count == 3);
            await Task.Delay(200);
            Assert.That(Values(received), Is.EqualTo(new[] { "m1", "m2", "m3" }));
            Assert.That(Sequences(received), Is.EqualTo(new long[] { 1, 2, 3 }));
        }

        [Test]
        public async Task Join_ResumesFromPersistedCursor()
        {
            var room = Room();
            var path = StatePath();
            var sender = await Sender();
            var first = Client(path);
            var before = Record(first, "notice");
            await first.Connect("valid");
            await first.Join(room);
            await Broadcast(sender, room, "m1");
            await Broadcast(sender, room, "m2");
            await WaitUntil(() => before.Count == 2);
            first.Dispose();

            await Broadcast(sender, room, "m3");
            var second = Client(path);
            var after = Record(second, "notice");
            await second.Connect("valid");
            await second.Join(room);

            await WaitUntil(() => after.Count == 1);
            await Task.Delay(200);
            Assert.That(Values(after), Is.EqualTo(new[] { "m3" }));
        }

        [Test]
        public async Task Join_RejectsExpiredCursor_AndAfterSeqRecovers()
        {
            var room = Room();
            var path = StatePath();
            var sender = await Sender();
            var first = Client(path);
            var before = Record(first, "notice");
            await first.Connect("valid");
            await first.Join(room);
            await Broadcast(sender, room, "m1");
            await WaitUntil(() => before.Count == 1);
            first.Dispose();
            for (var i = 2; i <= 5; i++) await Broadcast(sender, room, $"m{i}");

            var second = Client(path);
            var after = Record(second, "notice");
            await second.Connect("valid");
            var error = Assert.ThrowsAsync<SxException>(() => second.Join(room));

            Assert.That(error.Code, Is.EqualTo("RELIABLE_RESYNC_REQUIRED"));
            Assert.That((string)error.Details["reason"], Is.EqualTo("cursor_expired"));
            Assert.That((string)error.Details["room"], Is.EqualTo(room));
            Assert.That((long)error.Details["latestSeq"], Is.EqualTo(5));

            await second.Join(room, afterSeq: 5);
            await Broadcast(sender, room, "m6");
            await WaitUntil(() => after.Count == 1);
            Assert.That(Values(after), Is.EqualTo(new[] { "m6" }));
        }

        [Test]
        public async Task Rejoin_NotifiesResyncWhenHistoryExpiredWhileOffline()
        {
            var room = Room();
            var receiver = Client();
            var received = Record(receiver, "notice");
            var resync = Received(receiver, "sx_resync_required");
            await receiver.Connect("valid");
            await receiver.Join(room);
            var sender = await Sender();
            await Broadcast(sender, room, "m1");
            await WaitUntil(() => received.Count == 1);

            await receiver.Send("drop", new { blockMs = 500 });
            await WaitUntil(() => !receiver.IsConnected);
            for (var i = 2; i <= 5; i++) await Broadcast(sender, room, $"m{i}");

            var (data, _) = await WithPatience(resync);
            Assert.That((string)data["room"], Is.EqualTo(room));
            Assert.That((string)data["reason"], Is.EqualTo("cursor_expired"));
            Assert.That(Values(received), Is.EqualTo(new[] { "m1" }));
        }

        [Test]
        public async Task HandlerFailure_RetriesMessageBeforeLaterOnes()
        {
            var room = Room();
            var receiver = Client();
            var attempts = new List<string>();
            var handled = new List<string>();
            receiver.OnMessage("notice", (data, meta) =>
            {
                lock (attempts)
                {
                    attempts.Add((string)data);
                    if (attempts.Count == 1) throw new InvalidOperationException("first attempt fails");
                    handled.Add((string)data);
                }
            });
            await receiver.Connect("valid");
            await receiver.Join(room);
            var sender = await Sender();

            await Broadcast(sender, room, "a");
            await WaitUntil(() => { lock (attempts) return attempts.Count == 1; });
            await Broadcast(sender, room, "b");

            await WaitUntil(() => { lock (attempts) return handled.Count == 2; });
            Assert.That(attempts, Is.EqualTo(new[] { "a", "a", "b" }));
            Assert.That(handled, Is.EqualTo(new[] { "a", "b" }));
        }

        [Test]
        public async Task ReliableSend_ResolvesWithHandlerResultAndErrors()
        {
            var client = Client(send: true);
            await client.Connect("valid");

            var result = await client.Send("echo", "hello");
            Assert.That((string)result["data"], Is.EqualTo("hello"));
            Assert.That((long)result["meta"]["seq"], Is.EqualTo(1));

            var error = Assert.ThrowsAsync<SxException>(() => client.Send("fail"));
            Assert.That(error.Code, Is.EqualTo("2004"));
            Assert.That((long)(await client.Send("echo", "after"))["meta"]["seq"], Is.EqualTo(3));
        }

        [Test]
        public async Task ReliableSend_ResendsAfterLostAckWithoutRunningHandlerTwice()
        {
            var key = Guid.NewGuid().ToString();
            var client = Client(send: true);
            await client.Connect("valid");

            var result = await WithPatience(client.Send("count_and_drop", new { key }));

            Assert.That((int)result, Is.EqualTo(1));
            Assert.That((int)await client.Send("counts", new { key }), Is.EqualTo(1));
        }

        [Test]
        public async Task ReliableSend_PersistsOutboxAcrossClientInstances()
        {
            var key = Guid.NewGuid().ToString();
            var path = StatePath();
            var first = Client(path, send: true);
            var pending = first.Send("count", new { key });
            await Task.Delay(100);
            Assert.That(pending.IsCompleted, Is.False);
            first.Dispose();
            Assert.ThrowsAsync<ObjectDisposedException>(() => pending);

            var second = Client(path, send: true);
            await second.Connect("valid");

            Assert.That((int)await second.Send("counts", new { key }), Is.EqualTo(1));
        }

        [Test]
        public void StatePath_AllowsOneLiveClient()
        {
            var path = StatePath();
            Client(path);

            Assert.Throws<InvalidOperationException>(() => Client(path));
        }

        private SxClient Client(string statePath = null, bool send = false)
        {
            var client = new SxClient(_server.Url, new SxClientOptions
            {
                Timeout = Patience,
                ReconnectionDelay = 100,
                ReconnectionDelayMax = 200,
                Reliable = new SxReliableOptions { Enabled = send, StatePath = statePath }
            });
            _clients.Add(client);
            return client;
        }

        private async Task<SxClient> Sender()
        {
            var sender = Client();
            await sender.Connect("valid");
            return sender;
        }

        private static Task Broadcast(SxClient sender, string room, string data) =>
            sender.Send("broadcast", new { room, type = "notice", data });

        private static List<(JToken Data, JObject Meta)> Record(SxClient client, string route)
        {
            var received = new List<(JToken, JObject)>();
            client.OnMessage(route, (data, meta) =>
            {
                lock (received) received.Add((data, meta));
            });
            return received;
        }

        private static string[] Values(List<(JToken Data, JObject Meta)> received)
        {
            lock (received) return received.Select(entry => (string)entry.Data).ToArray();
        }

        private static long[] Sequences(List<(JToken Data, JObject Meta)> received)
        {
            lock (received) return received.Select(entry => (long)entry.Meta["seq"]).ToArray();
        }

        private string StatePath() => Path.Combine(_stateDirectory, "state.json");

        private static string Room() => "room-" + Guid.NewGuid();
    }
}
