using System;

namespace Shotx
{
    public sealed class SxClientOptions
    {
        public string Path { get; set; } = "/shotx/";
        public bool Reconnection { get; set; } = true;
        public double ReconnectionDelay { get; set; } = 1000;
        public int ReconnectionDelayMax { get; set; } = 30000;
        public int ReconnectionAttempts { get; set; } = int.MaxValue;

        /// <summary>Default timeout for Connect and Send. TimeSpan.Zero waits indefinitely.</summary>
        public TimeSpan Timeout { get; set; } = TimeSpan.Zero;

        public SxReliableOptions Reliable { get; set; } = new SxReliableOptions();
    }
}
