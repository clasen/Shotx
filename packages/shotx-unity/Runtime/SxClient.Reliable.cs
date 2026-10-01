using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using SioSocket = SocketIOClient.SocketIO;

namespace Shotx
{
    // Reliable delivery. All fields below and the store are guarded by _gate; user handlers never run under it.
    public sealed partial class SxClient
    {
        private const string ResyncCode = "RELIABLE_RESYNC_REQUIRED";

        private ReliableStore _reliableStore;
        private bool _sendReliable;
        private bool _disposed;
        private bool _readyReceived;
        private bool _reliableReady;
        private bool _flushRunning;
        private string _serverEpoch;
        private Exception _negotiationError;
        private Exception _outboundBlocked;
        private TaskCompletionSource<bool> _sessionEnded = NewSession();
        // Keyed by message ID, which is stable while a sequence may still be reassigned before negotiation.
        private readonly Dictionary<string, TaskCompletionSource<JToken>> _outboundPending = new Dictionary<string, TaskCompletionSource<JToken>>();
        private readonly Dictionary<string, ReliableRoom> _reliableRooms = new Dictionary<string, ReliableRoom>();

        private static TaskCompletionSource<bool> NewSession() =>
            new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        private void InitializeReliable()
        {
            var options = Options.Reliable ?? throw new ArgumentException("Reliable options must not be null", nameof(Options));
            _sendReliable = options.Enabled;
            var path = options.StatePath;
#if UNITY_5_3_OR_NEWER
            if (path == null)
            {
                using (var sha = System.Security.Cryptography.SHA256.Create())
                {
                    var key = System.Text.Encoding.UTF8.GetBytes(Url + "\0" + options.Id);
                    var name = BitConverter.ToString(sha.ComputeHash(key)).Replace("-", "").ToLowerInvariant();
                    path = System.IO.Path.Combine(UnityEngine.Application.persistentDataPath, "Shotx", name + ".json");
                }
            }
#endif
            _reliableStore = new ReliableStore(Url, options.Id, path);
        }

        private JObject Handshake(string token) => new JObject
        {
            ["token"] = token,
            ["reliableId"] = _reliableStore.State.Id,
            ["reliableEnabled"] = _sendReliable
        };

        private void BeginSession()
        {
            if (_sessionEnded.Task.IsCompleted) _sessionEnded = NewSession();
        }

        private void EndSession()
        {
            _readyReceived = false;
            _reliableReady = false;
            _negotiationError = null;
            _sessionEnded.TrySetResult(true);
        }

        private void NegotiateReliable(SioSocket socket, JObject ready)
        {
            lock (_gate)
            {
                if (_disposed || _socket != socket) return;
                _readyReceived = true;
                try
                {
                    var epoch = ready?["epoch"];
                    if (epoch == null || (epoch.Type != JTokenType.Null && (epoch.Type != JTokenType.String || ((string)epoch).Length == 0)))
                        throw new InvalidOperationException("Invalid reliable server epoch");
                    _serverEpoch = (string)epoch;
                    if (!_sendReliable) return;
                    if (!ValidSequence(ready["nextSeq"], 1)) throw new InvalidOperationException("Invalid reliable server sequence");

                    var nextSeq = (long)ready["nextSeq"];
                    var state = _reliableStore.Copy();
                    var epochChanged = state.HasOutboundEpoch && state.OutboundEpoch != _serverEpoch;
                    var dropped = new List<JObject>();
                    if (!state.HasOutboundEpoch || (epochChanged && state.Outbox.Count > 0))
                    {
                        // The server holds no record of these sequences: a client that never negotiated (since creation
                        // or DiscardReliableOutbox) transmitted nothing, and a new server history forgot what it received.
                        // Unsent messages take the server's next sequences; sent ones may already have run, so they are
                        // dropped instead of repeated.
                        long? firstQueued = null;
                        foreach (var seq in state.Outbox.Keys) { firstQueued = seq; break; }
                        var emittedSeq = state.EmittedSeq ?? firstQueued ?? 0;
                        var renumbered = new SortedDictionary<long, JObject>();
                        foreach (var queued in state.Outbox)
                        {
                            if (state.HasOutboundEpoch && queued.Key <= emittedSeq)
                            {
                                dropped.Add(queued.Value);
                                continue;
                            }
                            if (nextSeq + renumbered.Count >= ReliableStore.MaxSequence) throw new InvalidOperationException("Reliable sequence exhausted");
                            queued.Value["meta"]["seq"] = nextSeq + renumbered.Count;
                            renumbered.Add(nextSeq + renumbered.Count, queued.Value);
                        }
                        state.Outbox = renumbered;
                        state.NextSeq = nextSeq + renumbered.Count;
                        state.EmittedSeq = nextSeq - 1;
                    }
                    long? firstPending = null;
                    foreach (var seq in state.Outbox.Keys) { firstPending = seq; break; }
                    if (firstPending > nextSeq || (!firstPending.HasValue && !epochChanged && state.NextSeq > nextSeq))
                        throw ResyncError($"Reliable server expects sequence {nextSeq}, client expects {firstPending ?? state.NextSeq}", ready);

                    if (!firstPending.HasValue)
                    {
                        state.NextSeq = nextSeq;
                        state.EmittedSeq = nextSeq - 1;
                    }
                    state.OutboundEpoch = _serverEpoch;
                    state.HasOutboundEpoch = true;
                    _reliableStore.Commit(state);
                    if (dropped.Count > 0)
                    {
                        SxLog.Warn($"Dropped {dropped.Count} unacknowledged reliable messages after the server history changed");
                        var error = ResyncError("Reliable message may have run before the server history changed", ready);
                        foreach (var message in dropped)
                        {
                            var id = (string)message["meta"]["id"];
                            if (!_outboundPending.TryGetValue(id, out var pending)) continue;
                            _outboundPending.Remove(id);
                            pending.TrySetException(error);
                        }
                    }
                    _reliableReady = true;
                    ScheduleOutbox();
                }
                catch (Exception error)
                {
                    _negotiationError = error;
                    BlockOutbox(error);
                }
            }
        }

        /// <summary>Throws when this session cannot provide the reliable delivery the client requires.</summary>
        private void EnsureReliableSession(SioSocket socket)
        {
            if (!_sendReliable) return;
            lock (_gate)
            {
                if (_socket != socket) return;
                if (_negotiationError != null) throw _negotiationError;
                if (!_readyReceived) throw new SxException("Server does not support reliable client delivery", "RELIABLE_UNSUPPORTED");
            }
        }

        private static bool IsReliableApplication(string type) => !type.StartsWith("sx_", StringComparison.Ordinal);

        /// <summary>
        /// Removes every reliable message not yet acknowledged by the server and returns them in send order,
        /// so the application can inspect or resend them after resynchronizing. Clears a blocked outbox;
        /// the next connection adopts the server's sequence. Pending Send calls fail with RELIABLE_DISCARDED.
        /// Requires a disconnected client.
        /// </summary>
        public IReadOnlyList<JObject> DiscardReliableOutbox()
        {
            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException(nameof(SxClient));
                if (_socket != null) throw new InvalidOperationException("Disconnect before discarding the reliable outbox");
                var state = _reliableStore.Copy();
                var discarded = new List<JObject>(state.Outbox.Values);
                state.Outbox.Clear();
                state.HasOutboundEpoch = false;
                state.OutboundEpoch = null;
                _reliableStore.Commit(state);
                _outboundBlocked = null;
                _negotiationError = null;
                var error = new SxException("Reliable message was discarded", "RELIABLE_DISCARDED");
                foreach (var pending in _outboundPending.Values) pending.TrySetException(error);
                _outboundPending.Clear();
                return discarded;
            }
        }

        /// <summary>Where an unreadable reliable state file was moved at construction; null when none was found.</summary>
        public string CorruptStatePath => _reliableStore.CorruptPath;

        private Task<JToken> SendReliable(JObject message, TimeSpan timeout)
        {
            TaskCompletionSource<JToken> completion;
            long seq;
            var id = (string)message["meta"]["id"];
            lock (_gate)
            {
                if (_disposed) return Task.FromException<JToken>(new ObjectDisposedException(nameof(SxClient)));
                if (_outboundBlocked != null) return Task.FromException<JToken>(_outboundBlocked);
                try
                {
                    var state = _reliableStore.Copy();
                    if (state.NextSeq >= ReliableStore.MaxSequence) throw new InvalidOperationException("Reliable sequence exhausted");
                    seq = state.NextSeq++;
                    var meta = (JObject)message["meta"];
                    meta["stream"] = state.Id;
                    meta["seq"] = seq;
                    state.Outbox.Add(seq, (JObject)message.DeepClone());
                    _reliableStore.Commit(state);
                }
                catch (Exception error)
                {
                    return Task.FromException<JToken>(error);
                }
                completion = new TaskCompletionSource<JToken>(TaskCreationOptions.RunContinuationsAsynchronously);
                _outboundPending.Add(id, completion);
                ScheduleOutbox();
            }
            return WaitForReliable(id, completion.Task, timeout, (string)message["meta"]["type"]);
        }

        // A timeout abandons only the caller's wait; the persisted message is still delivered.
        private async Task<JToken> WaitForReliable(string id, Task<JToken> task, TimeSpan timeout, string type)
        {
            try
            {
                return await WithDeadline(task, timeout > TimeSpan.Zero ? Task.Delay(timeout) : null, type, timeout).ConfigureAwait(false);
            }
            finally
            {
                lock (_gate) _outboundPending.Remove(id);
            }
        }

        private void ScheduleOutbox()
        {
            if (_disposed || _flushRunning || !_reliableReady || !_isConnected || _outboundBlocked != null
                || _reliableStore.State.Outbox.Count == 0) return;
            _flushRunning = true;
            _ = Task.Run(FlushOutbox);
        }

        private async Task FlushOutbox()
        {
            try
            {
                while (true)
                {
                    SioSocket socket;
                    Task ended;
                    JObject message = null;
                    long seq = 0;
                    lock (_gate)
                    {
                        if (_disposed || !_reliableReady || !_isConnected || _outboundBlocked != null) return;
                        foreach (var entry in _reliableStore.State.Outbox) { seq = entry.Key; message = entry.Value; break; }
                        if (message == null) return;
                        if (!(seq <= _reliableStore.State.EmittedSeq))
                        {
                            var marked = _reliableStore.Copy();
                            marked.EmittedSeq = seq;
                            _reliableStore.Commit(marked);
                        }
                        socket = _socket;
                        ended = _sessionEnded.Task;
                    }

                    var reply = await Transmit(socket, message).ConfigureAwait(false);
                    if (await Task.WhenAny(reply, ended).ConfigureAwait(false) != reply || ended.IsCompleted) return;
                    var response = await reply.ConfigureAwait(false);

                    lock (_gate)
                    {
                        if (_disposed || _socket != socket || ended.IsCompleted) return;
                        var meta = response?["meta"] as JObject;
                        var code = meta?["code"]?.ToString();
                        // The earliest pending record was sent, so a requested gap is not in this outbox.
                        if (code == "RELIABLE_REPLAY_REQUIRED")
                            throw ResyncError($"Reliable client outbox is missing sequence {meta["expectedSeq"]}", meta);
                        if (code == ResyncCode || code == "RELIABLE_SEQUENCE_CONFLICT")
                            throw new SxException((string)meta["error"] ?? code, code) { Details = meta.DeepClone() };
                        if (meta?["reliable"]?.Type != JTokenType.Boolean || !(bool)meta["reliable"]
                            || !ValidSequence(meta["seq"], 1) || (long)meta["seq"] != seq
                            || (string)meta["id"] != (string)message["meta"]["id"] || meta["success"]?.Type != JTokenType.Boolean)
                            throw new InvalidOperationException($"Invalid reliable acknowledgement for sequence {seq}");

                        var state = _reliableStore.Copy();
                        state.Outbox.Remove(seq);
                        _reliableStore.Commit(state);
                        var id = (string)message["meta"]["id"];
                        if (_outboundPending.TryGetValue(id, out var pending))
                        {
                            _outboundPending.Remove(id);
                            if ((bool)meta["success"]) pending.TrySetResult(response["data"]);
                            else pending.TrySetException(new SxException((string)meta["error"] ?? "Unknown error", code));
                        }
                    }
                }
            }
            catch (Exception error)
            {
                SxLog.Error("Reliable client outbox failed", error);
                lock (_gate)
                {
                    if (!_disposed && _isConnected) BlockOutbox(error);
                }
            }
            finally
            {
                lock (_gate)
                {
                    _flushRunning = false;
                    ScheduleOutbox();
                }
            }
        }

        private void BlockOutbox(Exception error)
        {
            _outboundBlocked = error;
            _reliableReady = false;
            foreach (var pending in _outboundPending.Values) pending.TrySetException(error);
            _outboundPending.Clear();
        }

        private void DisposeReliable()
        {
            _disposed = true;
            EndSession();
            var error = new ObjectDisposedException(nameof(SxClient));
            foreach (var pending in _outboundPending.Values) pending.TrySetException(error);
            _outboundPending.Clear();
            _reliableRooms.Clear();
            _reliableStore.Dispose();
        }

        private ReliableRoom PrepareRoom(string room, long? afterSeq = null)
        {
            if (!_reliableRooms.TryGetValue(room, out var state) || afterSeq.HasValue)
            {
                ReliableCursor cursor = null;
                if (!afterSeq.HasValue) _reliableStore.State.Cursors.TryGetValue(room, out cursor);
                state = new ReliableRoom
                {
                    Room = room,
                    LastSeq = afterSeq ?? cursor?.Seq,
                    Epoch = cursor != null ? cursor.Epoch : _serverEpoch
                };
                _reliableRooms[room] = state;
            }
            if (!state.LastSeq.HasValue) state.Epoch = _serverEpoch;
            return state;
        }

        private async Task<JToken> JoinRoom(string room, long? afterSeq)
        {
            if (afterSeq < 0 || afterSeq > ReliableStore.MaxSequence) throw new ArgumentOutOfRangeException(nameof(afterSeq));
            ReliableRoom state;
            JObject request;
            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException(nameof(SxClient));
                state = PrepareRoom(room, afterSeq);
                request = JoinRequest(state);
            }

            var result = await Send("sx_join", request).ConfigureAwait(false);
            if (LostHistory(result?["reliable"]) is JObject lost)
            {
                lock (_gate)
                {
                    if (_disposed) throw new ObjectDisposedException(nameof(SxClient));
                    ResumeRoom(state, lost);
                    request = JoinRequest(state);
                }
                result = await Send("sx_join", request).ConfigureAwait(false);
                if (LostHistory(result?["reliable"]) is JObject again) throw RoomResyncError(room, again);
                await NotifyResync(state, lost).ConfigureAwait(false);
                return result;
            }
            if (afterSeq.HasValue)
            {
                lock (_gate)
                {
                    if (!_disposed && _reliableRooms.TryGetValue(room, out var current) && current == state) SaveCursor(state.Room, state.LastSeq.Value, state.Epoch);
                }
            }
            return result;
        }

        private static JObject JoinRequest(ReliableRoom state)
        {
            var request = new JObject { ["room"] = state.Room, ["epoch"] = state.Epoch };
            if (state.LastSeq.HasValue) request["afterSeq"] = state.LastSeq.Value;
            return request;
        }

        private static JObject LostHistory(JToken result) =>
            result is JObject reliable && (string)reliable["status"] == "resync_required" ? reliable : null;

        // The server no longer holds the history after this cursor (restart, expired retention or a reset store).
        // Those messages are gone, so the room continues from the oldest one retained.
        private void ResumeRoom(ReliableRoom state, JObject details)
        {
            if (!ValidSequence(details["earliestSeq"], 1)) throw new InvalidOperationException("Invalid reliable room history");
            state.LastSeq = (long)details["earliestSeq"] - 1;
            state.Epoch = _serverEpoch;
            state.Buffer.Clear();
            SaveCursor(state.Room, state.LastSeq.Value, state.Epoch);
        }

        private static SxException RoomResyncError(string room, JObject details)
        {
            var data = (JObject)details.DeepClone();
            data["room"] = room;
            return ResyncError($"Reliable room requires resynchronization: {room}", data);
        }

        private void ReceiveReliable(JObject message, JObject meta)
        {
            if (!ValidSequence(meta["seq"], 1) || meta["stream"]?.Type != JTokenType.String
                || meta["id"]?.Type != JTokenType.String || string.IsNullOrEmpty((string)meta["id"]))
            {
                SxLog.Warn("Received invalid reliable message envelope");
                return;
            }

            lock (_gate)
            {
                if (_disposed) return;
                var state = PrepareRoom((string)meta["stream"]);
                var seq = (long)meta["seq"];
                if (state.LastSeq.HasValue && seq <= state.LastSeq) return;
                if (!state.LastSeq.HasValue) state.LastSeq = seq - 1;
                if (!state.Buffer.ContainsKey(seq)) state.Buffer.Add(seq, message);
                ScheduleRoom(state);
            }
        }

        private void ScheduleRoom(ReliableRoom state)
        {
            if (_disposed || !state.LastSeq.HasValue) return;
            var next = state.LastSeq.Value + 1;
            if (!state.Draining && state.Buffer.ContainsKey(next))
            {
                state.Draining = true;
                _ = Task.Run(() => DrainRoom(state));
            }
            else if (!state.Draining && !state.Replaying && _isConnected && state.Buffer.Count > 0)
            {
                state.Replaying = true;
                var socket = _socket;
                var ended = _sessionEnded.Task;
                _ = Task.Run(() => ReplayRoom(state, next, socket, ended));
            }
        }

        private void ResumeReliableRooms()
        {
            lock (_gate)
            {
                foreach (var state in _reliableRooms.Values) ScheduleRoom(state);
            }
        }

        private async Task DrainRoom(ReliableRoom state)
        {
            var handlerFailed = false;
            try
            {
                while (true)
                {
                    JObject message;
                    Func<JToken, JObject, Task> handler;
                    long seq;
                    lock (_gate)
                    {
                        if (!IsCurrent(state)) return;
                        seq = state.LastSeq.Value + 1;
                        if (!state.Buffer.TryGetValue(seq, out message)) return;
                        var type = (string)message["meta"]["type"];
                        if (!_handlers.TryGetValue(type, out handler))
                        {
                            SxLog.Warn($"No handler for reliable route: {type}");
                            return;
                        }
                    }

                    try
                    {
                        await InvokeHandler(handler, message["data"]?.DeepClone(), (JObject)message["meta"].DeepClone()).ConfigureAwait(false);
                    }
                    catch (Exception error)
                    {
                        // The cursor stays put; the message is retried when the room is next scheduled.
                        handlerFailed = true;
                        SxLog.Error($"Error in reliable handler for route {message["meta"]["type"]}", error);
                        return;
                    }

                    lock (_gate)
                    {
                        if (!IsCurrent(state)) return;
                        SaveCursor(state.Room, seq, state.Epoch);
                        state.LastSeq = seq;
                        state.Buffer.Remove(seq);
                    }
                }
            }
            catch (Exception error)
            {
                handlerFailed = true;
                SxLog.Error($"Reliable room processing failed: {state.Room}", error);
            }
            finally
            {
                lock (_gate)
                {
                    state.Draining = false;
                    if (!handlerFailed) ScheduleRoom(state);
                }
            }
        }

        private bool IsCurrent(ReliableRoom state) =>
            !_disposed && _reliableRooms.TryGetValue(state.Room, out var current) && current == state;

        private void SaveCursor(string room, long seq, string epoch)
        {
            var saved = _reliableStore.Copy();
            saved.Cursors[room] = new ReliableCursor { Seq = seq, Epoch = epoch };
            _reliableStore.Commit(saved);
        }

        private async Task ReplayRoom(ReliableRoom state, long fromSeq, SioSocket socket, Task ended)
        {
            try
            {
                var message = new JObject
                {
                    ["meta"] = new JObject { ["type"] = "sx_replay", ["id"] = UuidV7.New() },
                    ["data"] = new JObject { ["room"] = state.Room, ["fromSeq"] = fromSeq, ["epoch"] = state.Epoch }
                };
                var reply = Deliver(socket, message, Options.Timeout);
                if (await Task.WhenAny(reply, ended).ConfigureAwait(false) != reply || ended.IsCompleted) return;
                if (LostHistory(await reply.ConfigureAwait(false)) is JObject lost)
                {
                    JObject request;
                    lock (_gate)
                    {
                        if (!IsCurrent(state)) return;
                        ResumeRoom(state, lost);
                        request = JoinRequest(state);
                    }
                    var rejoined = await Deliver(socket, new JObject
                    {
                        ["meta"] = new JObject { ["type"] = "sx_join", ["id"] = UuidV7.New() },
                        ["data"] = request
                    }, Options.Timeout).ConfigureAwait(false);
                    if (LostHistory(rejoined?["reliable"]) is JObject again) throw RoomResyncError(state.Room, again);
                    await NotifyResync(state, lost).ConfigureAwait(false);
                }
            }
            catch (Exception error)
            {
                SxLog.Error($"Failed to replay reliable room {state.Room}", error);
            }
            finally
            {
                lock (_gate) state.Replaying = false;
            }
        }

        private async Task NotifyResync(ReliableRoom state, JObject details)
        {
            Func<JToken, JObject, Task> handler;
            var data = (JObject)details.DeepClone();
            data["room"] = state.Room;
            lock (_gate)
            {
                if (!IsCurrent(state)) return;
                _handlers.TryGetValue("sx_resync_required", out handler);
            }

            SxLog.Warn($"Reliable room {state.Room} resumed after losing its history");
            if (handler == null) return;
            try
            {
                await InvokeHandler(handler, data.DeepClone(), null).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                SxLog.Error("Error in resynchronization handler", error);
            }
        }

        private Task InvokeHandler(Func<JToken, JObject, Task> handler, JToken data, JObject meta)
        {
            if (_context == null) return handler(data, meta);
            var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _context.Post(async _ =>
            {
                try
                {
                    await handler(data, meta);
                    completion.TrySetResult(true);
                }
                catch (Exception error)
                {
                    completion.TrySetException(error);
                }
            }, null);
            return completion.Task;
        }

        private static bool ValidSequence(JToken value, long minimum) =>
            value?.Type == JTokenType.Integer && (long)value >= minimum && (long)value <= ReliableStore.MaxSequence;

        private static SxException ResyncError(string message, JToken details) =>
            new SxException(message, ResyncCode) { Details = details?.DeepClone() };

        private sealed class ReliableRoom
        {
            internal string Room;
            internal long? LastSeq;
            internal string Epoch;
            internal bool Draining;
            internal bool Replaying;
            internal readonly SortedDictionary<long, JObject> Buffer = new SortedDictionary<long, JObject>();
        }
    }
}
