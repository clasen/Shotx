using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using SocketIO.Serializer.NewtonsoftJson;
using SocketIOClient;
using SioSocket = SocketIOClient.SocketIO;

namespace Shotx
{
    /// <summary>
    /// Shotx client. Message handlers run on the SynchronizationContext captured at construction
    /// (the Unity main thread when constructed from a MonoBehaviour).
    /// </summary>
    public sealed partial class SxClient : IDisposable
    {
        private const string RouteEvent = "message";

        private readonly object _gate = new object();
        private readonly SynchronizationContext _context;
        private readonly Dictionary<string, Func<JToken, JObject, Task>> _handlers = new Dictionary<string, Func<JToken, JObject, Task>>();
        private readonly Queue<QueuedMessage> _offlineQueue = new Queue<QueuedMessage>();
        private readonly List<string> _joinedRooms = new List<string>();
        private SioSocket _socket;
        private bool _isConnected;

        public SxClient(string url = "http://localhost:3000", SxClientOptions options = null)
        {
            Url = url ?? throw new ArgumentNullException(nameof(url));
            Options = options ?? new SxClientOptions();
            _context = SynchronizationContext.Current;
            InitializeReliable();
        }

        public string Url { get; }
        public SxClientOptions Options { get; }

        public bool IsConnected
        {
            get
            {
                lock (_gate) return _isConnected;
            }
        }

        /// <summary>
        /// Connects and authenticates with <paramref name="token"/> (a UUID v7 when null).
        /// Resolves with the server's auth data once the offline queue is flushed and rooms are rejoined.
        /// </summary>
        public async Task<JToken> Connect(string token = null, TimeSpan? timeout = null)
        {
            var authenticated = new TaskCompletionSource<JToken>(TaskCreationOptions.RunContinuationsAsynchronously);
            var limit = timeout ?? Options.Timeout;
            var deadline = limit > TimeSpan.Zero ? Task.Delay(limit) : null;
            SioSocket previous;
            SioSocket socket;
            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException(nameof(SxClient));
                if (_isConnected) return null;
                previous = _socket;
                socket = CreateSocket(token ?? UuidV7.New(), authenticated);
                _socket = socket;
            }

            previous?.Dispose();
            _ = socket.ConnectAsync().ContinueWith(
                task => authenticated.TrySetException(task.Exception.InnerExceptions),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);

            return await WithDeadline(authenticated.Task, deadline, "connect", limit).ConfigureAwait(false);
        }

        public async Task Disconnect()
        {
            SioSocket socket;
            lock (_gate)
            {
                socket = _socket;
                _socket = null;
                _isConnected = false;
                EndSession();
            }

            if (socket == null) return;
            await socket.DisconnectAsync().ConfigureAwait(false);
            socket.Dispose();
        }

        public void Dispose()
        {
            SioSocket socket;
            lock (_gate)
            {
                socket = _socket;
                _socket = null;
                _isConnected = false;
                if (!_disposed) DisposeReliable();
            }

            socket?.Dispose();
        }

        /// <summary>
        /// Sends <paramref name="data"/> to the server handler registered for <paramref name="type"/>
        /// and resolves with its result. While disconnected, the message is queued until reconnection.
        /// With Reliable.Enabled, application messages are persisted, sequenced and deduplicated instead;
        /// a timeout abandons only the wait, not the persisted message.
        /// </summary>
        public Task<JToken> Send(string type, object data = null, TimeSpan? timeout = null)
        {
            if (type == null) throw new ArgumentNullException(nameof(type));

            var message = new JObject
            {
                ["meta"] = new JObject { ["type"] = type, ["id"] = UuidV7.New() },
                ["data"] = data == null ? JValue.CreateNull() : data as JToken ?? JToken.FromObject(data)
            };
            var limit = timeout ?? Options.Timeout;
            if (_sendReliable && IsReliableApplication(type)) return SendReliable(message, limit);

            SioSocket socket;
            lock (_gate)
            {
                if (!_isConnected)
                {
                    var queued = new QueuedMessage(message);
                    _offlineQueue.Enqueue(queued);
                    return queued.Completion.Task;
                }
                socket = _socket;
            }

            return Deliver(socket, message, limit);
        }

        /// <summary>
        /// Joins a room, resuming reliable delivery from the persisted cursor, or after afterSeq when given.
        /// Throws SxException RELIABLE_RESYNC_REQUIRED when the cursor is outside the retained history.
        /// </summary>
        public async Task<JToken> Join(string room, long? afterSeq = null)
        {
            if (room == null) throw new ArgumentNullException(nameof(room));

            var result = await JoinRoom(room, afterSeq).ConfigureAwait(false);
            lock (_gate)
            {
                if (!_joinedRooms.Contains(room)) _joinedRooms.Add(room);
            }
            return result;
        }

        public async Task<JToken> Leave(string room)
        {
            if (room == null) throw new ArgumentNullException(nameof(room));

            var result = await Send("sx_leave", new JObject { ["room"] = room }).ConfigureAwait(false);
            lock (_gate)
            {
                _joinedRooms.Remove(room);
                _reliableRooms.Remove(room);
            }
            return result;
        }

        /// <summary>Registers the handler for messages of type <paramref name="route"/>; receives (data, meta).</summary>
        public void OnMessage(string route, Func<JToken, JObject, Task> handler)
        {
            if (route == null) throw new ArgumentNullException(nameof(route));
            if (handler == null) throw new ArgumentNullException(nameof(handler));

            lock (_gate)
            {
                _handlers[route] = handler;
            }
            ResumeReliableRooms();
        }

        public void OnMessage(string route, Action<JToken, JObject> handler)
        {
            if (handler == null) throw new ArgumentNullException(nameof(handler));

            OnMessage(route, (data, meta) =>
            {
                handler(data, meta);
                return Task.CompletedTask;
            });
        }

        private SioSocket CreateSocket(string token, TaskCompletionSource<JToken> authenticated)
        {
            var socket = new SioSocket(Url, new SocketIOOptions
            {
                Path = Options.Path.TrimEnd('/'),
                Reconnection = Options.Reconnection,
                ReconnectionDelay = Options.ReconnectionDelay,
                ReconnectionDelayMax = Options.ReconnectionDelayMax,
                ReconnectionAttempts = Options.ReconnectionAttempts,
                Auth = Handshake(token)
            })
            {
                Serializer = new NewtonsoftJsonSerializer()
            };

            socket.OnConnected += (sender, args) => SetConnected(socket, true);
            socket.OnDisconnected += (sender, reason) => SetConnected(socket, false);
            socket.OnError += (sender, error) =>
            {
                lock (_gate)
                {
                    if (_socket == socket) _socket = null;
                }
                socket.Dispose();
                authenticated.TrySetException(new SxException(error, error));
            };
            OnOrdered(socket, "sx_reliable_ready", response => NegotiateReliable(socket, response.GetValue<JToken>(0) as JObject));
            socket.On("auth_success", (Func<SocketIOResponse, Task>)(async response =>
            {
                try
                {
                    EnsureReliableSession(socket);
                }
                catch (Exception error)
                {
                    lock (_gate)
                    {
                        if (_socket == socket)
                        {
                            _socket = null;
                            _isConnected = false;
                            EndSession();
                        }
                    }
                    socket.Dispose();
                    if (!authenticated.TrySetException(error)) SxLog.Error("Reliable session failed", error);
                    return;
                }

                try
                {
                    var auth = response.GetValue<JToken>(0);
                    await ProcessQueue(socket).ConfigureAwait(false);
                    await RejoinRooms(socket).ConfigureAwait(false);
                    lock (_gate) ScheduleOutbox();
                    authenticated.TrySetResult(auth);
                }
                catch (Exception error)
                {
                    if (!authenticated.TrySetException(error)) SxLog.Error("Failed to resume session", error);
                }
            }));
            OnOrdered(socket, RouteEvent, response => Route(response.GetValue<JToken>(0) as JObject));
            return socket;
        }

        // SocketIOClient runs Action handlers on the thread pool, losing arrival order; Func handlers run
        // synchronously on its receive loop, so they must return quickly and must not throw into it.
        private static void OnOrdered(SioSocket socket, string eventName, Action<SocketIOResponse> handler)
        {
            socket.On(eventName, (Func<SocketIOResponse, Task>)(response =>
            {
                try
                {
                    handler(response);
                }
                catch (Exception error)
                {
                    SxLog.Error($"Error handling event {eventName}", error);
                }
                return Task.CompletedTask;
            }));
        }

        private void SetConnected(SioSocket socket, bool connected)
        {
            lock (_gate)
            {
                if (_socket != socket) return;
                _isConnected = connected;
                if (connected) BeginSession();
                else EndSession();
            }
        }

        private async Task ProcessQueue(SioSocket socket)
        {
            while (true)
            {
                QueuedMessage next;
                lock (_gate)
                {
                    if (!_isConnected || _socket != socket || _offlineQueue.Count == 0) return;
                    next = _offlineQueue.Dequeue();
                }

                try
                {
                    var reply = await Transmit(socket, next.Message).ConfigureAwait(false);
                    Forward(Complete(reply, next.Message, Options.Timeout), next.Completion);
                }
                catch (Exception error)
                {
                    next.Completion.TrySetException(error);
                }
            }
        }

        private async Task RejoinRooms(SioSocket socket)
        {
            string[] rooms;
            lock (_gate)
            {
                rooms = _joinedRooms.ToArray();
            }

            foreach (var room in rooms)
            {
                try
                {
                    await JoinRoom(room, null).ConfigureAwait(false);
                }
                catch (SxException error) when (error.Code == ResyncCode)
                {
                    ReliableRoom state;
                    lock (_gate) _reliableRooms.TryGetValue(room, out state);
                    if (state != null) await NotifyResync(state, (JObject)error.Details).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    SxLog.Error($"Failed to rejoin room {room}", error);
                }
            }
        }

        private void Route(JObject message)
        {
            var meta = message?["meta"] as JObject;
            var type = meta?["type"]?.Type == JTokenType.String ? (string)meta["type"] : null;
            if (type == null)
            {
                SxLog.Warn("Received message without meta.type");
                return;
            }
            if (meta["seq"] != null || meta["stream"] != null)
            {
                ReceiveReliable(message, meta);
                return;
            }

            Func<JToken, JObject, Task> handler;
            lock (_gate)
            {
                if (!_handlers.TryGetValue(type, out handler)) return;
            }

            if (_context == null)
            {
                _ = RunHandler(type, handler, message["data"], meta);
                return;
            }
            _context.Post(_ => _ = RunHandler(type, handler, message["data"], meta), null);
        }

        private static async Task RunHandler(string type, Func<JToken, JObject, Task> handler, JToken data, JObject meta)
        {
            try
            {
                await handler(data, meta);
            }
            catch (Exception error)
            {
                SxLog.Error($"Error in message handler for route {type}", error);
            }
        }

        private async Task<JToken> Deliver(SioSocket socket, JObject message, TimeSpan timeout)
        {
            var reply = await Transmit(socket, message).ConfigureAwait(false);
            return await Complete(reply, message, timeout).ConfigureAwait(false);
        }

        private static async Task<Task<JToken>> Transmit(SioSocket socket, JObject message)
        {
            var reply = new TaskCompletionSource<JToken>(TaskCreationOptions.RunContinuationsAsynchronously);
            await socket.EmitAsync(RouteEvent, response =>
            {
                try
                {
                    reply.TrySetResult(response.GetValue<JToken>(0));
                }
                catch (Exception error)
                {
                    reply.TrySetException(error);
                }
            }, message).ConfigureAwait(false);
            return reply.Task;
        }

        private static async Task<JToken> Complete(Task<JToken> reply, JObject message, TimeSpan timeout)
        {
            var deadline = timeout > TimeSpan.Zero ? Task.Delay(timeout) : null;
            var response = await WithDeadline(reply, deadline, (string)message["meta"]["type"], timeout).ConfigureAwait(false);

            var meta = response?["meta"] as JObject;
            if (meta == null) throw new InvalidOperationException("Invalid Shotx response: missing meta");
            if (meta["success"]?.Type != JTokenType.Boolean || !(bool)meta["success"])
            {
                throw new SxException((string)meta["error"] ?? "Unknown error", meta["code"]?.ToString());
            }
            return response["data"];
        }

        private static async Task<T> WithDeadline<T>(Task<T> task, Task deadline, string label, TimeSpan timeout)
        {
            if (deadline != null && await Task.WhenAny(task, deadline).ConfigureAwait(false) != task)
            {
                throw new TimeoutException($"TIMEOUT: {label} ({timeout.TotalMilliseconds}ms)");
            }
            return await task.ConfigureAwait(false);
        }

        private static void Forward(Task<JToken> source, TaskCompletionSource<JToken> target)
        {
            source.ContinueWith(task =>
            {
                if (task.IsFaulted) target.TrySetException(task.Exception.InnerExceptions);
                else if (task.IsCanceled) target.TrySetCanceled();
                else target.TrySetResult(task.Result);
            }, TaskScheduler.Default);
        }

        private sealed class QueuedMessage
        {
            public QueuedMessage(JObject message)
            {
                Message = message;
            }

            public JObject Message { get; }
            public TaskCompletionSource<JToken> Completion { get; } =
                new TaskCompletionSource<JToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }
}
