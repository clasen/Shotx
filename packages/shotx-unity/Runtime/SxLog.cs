using System;

namespace Shotx
{
    internal static class SxLog
    {
        public static void Warn(string message)
        {
#if UNITY_5_3_OR_NEWER
            UnityEngine.Debug.LogWarning($"[Shotx] {message}");
#else
            System.Diagnostics.Trace.TraceWarning($"[Shotx] {message}");
#endif
        }

        public static void Error(string message, Exception exception)
        {
#if UNITY_5_3_OR_NEWER
            UnityEngine.Debug.LogError($"[Shotx] {message}: {exception}");
#else
            System.Diagnostics.Trace.TraceError($"[Shotx] {message}: {exception}");
#endif
        }
    }
}
