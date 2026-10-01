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
                var state = _path != null && File.Exists(_path) ? Load() : null;
                state ??= new ReliableState { Url = url, Id = id ?? UuidV7.New(), EmittedSeq = 0 };
                if (state.Url != url || (id != null && state.Id != id))
                    throw new InvalidOperationException($"Reliable state belongs to a different server or consumer: {_path}");
                Commit(state);
            }
            catch
            {
                _lease?.Dispose();
                throw;
            }
        }

        internal ReliableState State { get; private set; }

        /// <summary>Where an unreadable state file was moved during construction; null when none was found.</summary>
        internal string CorruptPath { get; private set; }

        // Unreadable state is set aside for inspection rather than blocking the client forever.
        // Its identity, cursors and pending messages are lost; I/O failures still propagate.
        private ReliableState Load()
        {
            try
            {
                var state = JsonConvert.DeserializeObject<ReliableState>(File.ReadAllText(_path), JsonSettings);
                Validate(state);
                return state;
            }
            catch (Exception error) when (error is JsonException || error is InvalidDataException)
            {
                CorruptPath = _path + ".corrupt";
                if (File.Exists(CorruptPath)) File.Delete(CorruptPath);
                File.Move(_path, CorruptPath);
                SxLog.Error($"Reliable state was unreadable and was moved to {CorruptPath}", error);
                return null;
            }
        }

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
                || (state.OutboundEpoch != null && state.OutboundEpoch.Length == 0)
                || state.EmittedSeq < 0 || state.EmittedSeq >= state.NextSeq)
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
        // Highest sequence ever transmitted. Only the earliest pending message can have been sent without an
        // acknowledgement, so this tells which pending messages the server may have run. Null in older state files.
        public long? EmittedSeq { get; set; }
        public Dictionary<string, ReliableCursor> Cursors { get; set; } = new Dictionary<string, ReliableCursor>();
        public SortedDictionary<long, JObject> Outbox { get; set; } = new SortedDictionary<long, JObject>();
    }

    internal sealed class ReliableCursor
    {
        public long Seq { get; set; }
        public string Epoch { get; set; }
    }
}
