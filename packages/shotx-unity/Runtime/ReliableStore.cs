using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Shotx
{
    internal sealed class ReliableStore : IDisposable
    {
        internal const long MaxSequence = 9007199254740991;
        private readonly string _path;
        private readonly FileStream _lease;
        private static readonly JsonSerializerSettings JsonSettings = new JsonSerializerSettings
        {
            DateParseHandling = DateParseHandling.None
        };

        internal ReliableStore(string url, string id, string path)
        {
            if (id != null && string.IsNullOrWhiteSpace(id)) throw new ArgumentException("Reliable ID must not be empty", nameof(id));
            if (path != null && string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Reliable state path must not be empty", nameof(path));
            _path = path == null ? null : Path.GetFullPath(path);
            try
            {
                if (_path != null)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(_path));
                    try
                    {
                        _lease = new FileStream(_path + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    }
                    catch (IOException error)
                    {
                        throw new InvalidOperationException(
                            $"Reliable state is in use by another SxClient: {_path}. Dispose it or configure a distinct Reliable.Id or StatePath.", error);
                    }
                }
                State = _path != null && File.Exists(_path)
                    ? JsonConvert.DeserializeObject<ReliableState>(File.ReadAllText(_path), JsonSettings)
                    : new ReliableState { Url = url, Id = id ?? UuidV7.New() };
                Validate(State);
                if (State.Url != url || (id != null && State.Id != id))
                    throw new InvalidDataException("Reliable state belongs to a different server or consumer");
                Commit(State);
            }
            catch
            {
                _lease?.Dispose();
                throw;
            }
        }

        internal ReliableState State { get; private set; }

        internal ReliableState Copy() => JsonConvert.DeserializeObject<ReliableState>(JsonConvert.SerializeObject(State), JsonSettings);

        // Called under SxClient's gate; publish the new in-memory state only after the atomic write.
        internal void Commit(ReliableState state)
        {
            if (_path != null)
            {
                var temporary = _path + ".tmp";
                var bytes = System.Text.Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(state));
                using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    file.Write(bytes, 0, bytes.Length);
                    file.Flush(true);
                }
                if (File.Exists(_path)) File.Replace(temporary, _path, null);
                else File.Move(temporary, _path);
            }
            State = state;
        }

        public void Dispose() => _lease?.Dispose();

        private static void Validate(ReliableState state)
        {
            if (state == null || state.Version != 1 || string.IsNullOrEmpty(state.Url) || string.IsNullOrEmpty(state.Id)
                || state.NextSeq < 1 || state.NextSeq > MaxSequence || state.Cursors == null || state.Outbox == null
                || (state.OutboundEpoch != null && state.OutboundEpoch.Length == 0))
                throw new InvalidDataException("Invalid reliable state");
            foreach (var cursor in state.Cursors.Values)
            {
                if (cursor == null || cursor.Seq < 0 || cursor.Seq > MaxSequence || cursor.Epoch?.Length == 0)
                    throw new InvalidDataException("Invalid reliable room cursor");
            }
            long? previous = null;
            foreach (var entry in state.Outbox)
            {
                var meta = entry.Value?["meta"] as JObject;
                if (entry.Key < 1 || entry.Key >= state.NextSeq || (previous.HasValue && entry.Key != previous + 1)
                    || meta == null || meta["seq"]?.Type != JTokenType.Integer || (long)meta["seq"] != entry.Key
                    || (string)meta["stream"] != state.Id || meta["id"]?.Type != JTokenType.String || string.IsNullOrEmpty((string)meta["id"])
                    || meta["type"]?.Type != JTokenType.String || ((string)meta["type"]).StartsWith("sx_", StringComparison.Ordinal))
                    throw new InvalidDataException("Invalid reliable outbox");
                previous = entry.Key;
            }
            if (previous.HasValue && previous != state.NextSeq - 1)
                throw new InvalidDataException("Reliable outbox has a sequence gap");
        }
    }

    internal sealed class ReliableState
    {
        public int Version { get; set; } = 1;
        public string Url { get; set; }
        public string Id { get; set; }
        public long NextSeq { get; set; } = 1;
        public bool HasOutboundEpoch { get; set; }
        public string OutboundEpoch { get; set; }
        public Dictionary<string, ReliableCursor> Cursors { get; set; } = new Dictionary<string, ReliableCursor>();
        public SortedDictionary<long, JObject> Outbox { get; set; } = new SortedDictionary<long, JObject>();
    }

    internal sealed class ReliableCursor
    {
        public long Seq { get; set; }
        public string Epoch { get; set; }
    }
}
