using System.IO;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.UnityLinker;

namespace Shotx.Editor
{
    /// <summary>Unity ignores link.xml files inside packages; this passes the package's file to the linker.</summary>
    internal sealed class ShotxLinkerProcessor : IUnityLinkerProcessor
    {
        public int callbackOrder => 0;

        public string GenerateAdditionalLinkXmlFile(BuildReport report, UnityLinkerBuildPipelineData data) =>
            Path.GetFullPath("Packages/com.clasen.shotx/Runtime/link.xml");

        // Interface members in older Unity versions; unused by newer ones.
        public void OnBeforeRun(BuildReport report, UnityLinkerBuildPipelineData data) { }

        public void OnAfterRun(BuildReport report, UnityLinkerBuildPipelineData data) { }
    }
}
