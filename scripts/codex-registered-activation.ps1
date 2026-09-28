param(
  [ValidateRange(0, 65535)][int]$Port = 0,
  [Parameter(Mandatory = $true)][string]$ExpectedPath,
  [ValidateSet('source-test', 'launcher', 'ordinary')][string]$Mode = 'source-test'
)

$ErrorActionPreference = 'Stop'
$sourceSelected = $env:AGENT_DESK_LOOPBACK_CANDIDATE -ceq '1'
$launcherSelected = $env:AGENT_DESK_WINDOWS_TRANSPORT -ceq 'registered-loopback'
if (($Mode -ceq 'source-test' -and -not $sourceSelected) -or
    ($Mode -ceq 'launcher' -and -not $launcherSelected) -or
    ($Mode -ceq 'ordinary' -and -not ($sourceSelected -or $launcherSelected))) {
  throw 'Registered activation mode was not selected by Agent Desk.'
}
if (($Mode -ceq 'ordinary' -and $Port -ne 0) -or
    ($Mode -cne 'ordinary' -and $Port -lt 1024)) {
  throw 'Invalid registered activation port.'
}
if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
  throw 'Exit Codex normally before starting Agent Desk; attaching is not supported.'
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
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Official package manifest missing.' }
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
public static class AgentDeskRegisteredActivation {
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
$arguments = ''
if ($Mode -cne 'ordinary') {
  $existingListener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($existingListener.Count -ne 0) { throw 'CDP port was taken before activation.' }
  $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port --remote-allow-origins=http://127.0.0.1:$Port"
}
$activatedPid = [int][AgentDeskRegisteredActivation]::Activate("$($package.PackageFamilyName)!App", $arguments)
$owned = $false
if ($Mode -cne 'ordinary') {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $activatedProcess = Get-Process -Id $activatedPid -ErrorAction SilentlyContinue
    if ($null -eq $activatedProcess) { throw 'Registered Codex exited before CDP became ready.' }
    if ([IO.Path]::GetFullPath($activatedProcess.Path) -ine [IO.Path]::GetFullPath($appPath)) {
      throw 'Activated process path does not match the validated package.'
    }
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
      if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -cne '127.0.0.1' -or
          [int]$listeners[0].OwningProcess -ne $activatedPid) {
        throw 'CDP listener is not loopback-only or owned by activated Codex.'
      }
      $owned = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $owned) { throw 'Registered Codex CDP listener did not appear.' }
}
[pscustomobject]@{pid=$activatedPid;packageVersion=[string]$package.Version;
  identityVerified=$true;signaturesValid=$true;listenerOwned=$owned} | ConvertTo-Json -Compress
