namespace Shotx
{
    public sealed class SxReliableOptions
    {
        /// <summary>Enables reliable sending. Reliable room reception is always automatic.</summary>
        public bool Enabled { get; set; }

        /// <summary>Stable, non-secret logical consumer ID. Generated and persisted when omitted.</summary>
        public string Id { get; set; }

        /// <summary>
        /// State file for identity, room cursors and outbound messages. In Unity, null selects a file
        /// under Application.persistentDataPath. Outside Unity, null selects in-memory storage.
        /// A state file supports only one live client and must not be shared between users.
        /// </summary>
        public string StatePath { get; set; }
    }
}
