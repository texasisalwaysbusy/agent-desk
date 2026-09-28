param(
  [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$Port,
  [Parameter(Mandatory = $true)][string]$ExpectedPath
)

$ErrorActionPreference = 'Stop'
# Source-test candidate only. Another same-machine process can access this CDP port.
if ($env:AGENT_DESK_LOOPBACK_CANDIDATE -cne '1') {
  throw 'The loopback candidate requires explicit source-test opt-in.'
}
if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
  throw 'Exit Codex normally before starting the source-test candidate.'
}

$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop |
  Where-Object {
    $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' -and
    [string]$_.SignatureKind -eq 'Store'
  } | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $package) { throw 'Official registered Codex Store package not found.' }
$root = [IO.Path]::GetFullPath([string]$package.InstallLocation)
$manifestPath = Join-Path $root 'AppxManifest.xml'
$appPath = Join-Path $root 'app\ChatGPT.exe'
$corePath = Join-Path $root 'app\resources\codex.exe'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'Official package manifest missing.'
}
[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$mainApplications = @($manifest.Package.Applications.Application |
  Where-Object { [string]$_.Id -ceq 'App' })
if ([string]$manifest.Package.Identity.Name -cne 'OpenAI.Codex' -or
    [string]$manifest.Package.Identity.Publisher -cne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B' -or
    [string]$manifest.Package.Identity.Version -cne [string]$package.Version -or
    $mainApplications.Count -ne 1 -or
    [string]$mainApplications[0].Executable -cne 'app/ChatGPT.exe' -or
    [string]$mainApplications[0].EntryPoint -cne 'Windows.FullTrustApplication' -or
    [IO.Path]::GetFullPath($ExpectedPath) -ine [IO.Path]::GetFullPath($appPath)) {
  throw 'Registered package identity or expected path mismatch.'
}
foreach ($file in @($appPath, $corePath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
      [string](Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid') {
    throw 'Official package executable signature invalid.'
  }
}

$activationSource = @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
        [In] uint options, [Out] out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}
public static class AgentDeskCandidateActivation {
    public static uint Activate(string appUserModelId, string arguments) {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid;
        int result = manager.ActivateApplication(appUserModelId, arguments, 0, out pid);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        return pid;
    }
}
'@
Add-Type -TypeDefinition $activationSource -ErrorAction Stop

$existingListener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($existingListener.Count -ne 0) { throw 'Candidate CDP port was taken before activation.' }
$arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port --remote-allow-origins=http://127.0.0.1:$Port"
$aumid = "$($package.PackageFamilyName)!App"
$activatedPid = [int][AgentDeskCandidateActivation]::Activate($aumid, $arguments)
$deadline = (Get-Date).AddSeconds(20)
$owned = $false
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $activatedPid -ErrorAction SilentlyContinue)) {
    throw 'Registered Codex process exited before CDP became ready.'
  }
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    if ($listeners.Count -ne 1 -or
        [string]$listeners[0].LocalAddress -ne '127.0.0.1' -or
        [int]$listeners[0].OwningProcess -ne $activatedPid) {
      throw 'Candidate CDP listener is not owned by the activated Codex process.'
    }
    $owned = $true
    break
  }
  Start-Sleep -Milliseconds 250
}
if (-not $owned) { throw 'Registered Codex CDP listener did not appear.' }
[pscustomobject]@{
  pid = $activatedPid
  packageVersion = [string]$package.Version
  identityVerified = $true
  signaturesValid = $true
  listenerOwned = $true
} | ConvertTo-Json -Compress
