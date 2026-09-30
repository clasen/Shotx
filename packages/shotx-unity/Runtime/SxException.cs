using System;
using Newtonsoft.Json.Linq;

namespace Shotx
{
    /// <summary>
    /// Error reported by a Shotx server: a rejected handshake (AUTH_NULL, AUTH_FAIL, AUTH_ERROR, ...),
    /// a failed message response (2001-2004, ...) or a reliable delivery failure (RELIABLE_*).
    /// </summary>
    public sealed class SxException : Exception
    {
        public SxException(string message, string code) : base(message)
        {
            Code = code;
        }

        public string Code { get; }

        /// <summary>Server-provided details, such as the room, reason and sequences of RELIABLE_RESYNC_REQUIRED.</summary>
        public JToken Details { get; internal set; }
    }
}
