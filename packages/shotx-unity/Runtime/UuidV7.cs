using System;
using System.Security.Cryptography;

namespace Shotx
{
    internal static class UuidV7
    {
        private static readonly RandomNumberGenerator Rng = RandomNumberGenerator.Create();

        public static string New()
        {
            var bytes = new byte[16];
            lock (Rng)
            {
                Rng.GetBytes(bytes, 6, 10);
            }

            var ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            for (var i = 5; i >= 0; i--)
            {
                bytes[i] = (byte)(ms & 0xFF);
                ms >>= 8;
            }

            bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70);
            bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

            var hex = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            return $"{hex.Substring(0, 8)}-{hex.Substring(8, 4)}-{hex.Substring(12, 4)}-{hex.Substring(16, 4)}-{hex.Substring(20, 12)}";
        }
    }
}
