param(
  [switch]$PreflightOnly,
  [ValidateRange(5, 30)]
  [int]$Seconds = 15
)

$ErrorActionPreference = 'Stop'

# The caller supplies private CDP pipe descriptors 3 and 4. This probe never
# reads a renderer, terminates Codex, or changes the registered package.
if (-not $PreflightOnly -and (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)) {
  throw 'Exit every Codex/ChatGPT desktop window normally before this probe.'
}

$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop |
  Where-Object {
    $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' -and
    [string]$_.SignatureKind -eq 'Store'
  } |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($null -eq $package) { throw 'The registered official Codex Store package was not found.' }

$packageRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation)
$manifestPath = Join-Path $packageRoot 'AppxManifest.xml'
$appPath = Join-Path $packageRoot 'app\ChatGPT.exe'
$corePath = Join-Path $packageRoot 'app\resources\codex.exe'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'The registered package manifest is missing.'
}
[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$identity = $manifest.Package.Identity
$mainApplications = @($manifest.Package.Applications.Application |
  Where-Object { [string]$_.Id -ceq 'App' })
if ([string]$identity.Name -cne 'OpenAI.Codex' -or
    [string]$identity.Publisher -cne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B' -or
    [string]$identity.Version -cne [string]$package.Version -or
    $mainApplications.Count -ne 1 -or
    [string]$mainApplications[0].Executable -cne 'app/ChatGPT.exe' -or
    [string]$mainApplications[0].EntryPoint -cne 'Windows.FullTrustApplication') {
  throw 'The registered package identity does not match the official manifest.'
}
foreach ($file in @($appPath, $corePath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
      [string](Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid') {
    throw "The official package executable failed its signature check: $([IO.Path]::GetFileName($file))"
  }
}

$activationSource = @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication(
        [In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
        [In] uint options,
        [Out] out uint processId);
}

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

public static class CodexPrivatePipeProbe {
    public static uint Activate(string appUserModelId) {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid;
        int result = manager.ActivateApplication(appUserModelId, "--remote-debugging-pipe", 0, out pid);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        return pid;
    }
}
'@
Add-Type -TypeDefinition $activationSource -ErrorAction Stop

if ($PreflightOnly) {
  [pscustomobject]@{
    packageVersion = [string]$package.Version
    identityVerified = $true
    signaturesValid = $true
    activationCompiled = $true
    launched = $false
  } | ConvertTo-Json -Compress
  return
}

$appUserModelId = "$($package.PackageFamilyName)!$($mainApplications[0].Id)"
$activatedPid = [CodexPrivatePipeProbe]::Activate($appUserModelId)
$started = Get-Date
$windowSeen = $false
$processAlive = $false
while (((Get-Date) - $started).TotalSeconds -lt $Seconds) {
  $process = Get-Process -Id $activatedPid -ErrorAction SilentlyContinue
  if ($null -eq $process) { break }
  $processAlive = $true
  if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windowSeen = $true }
  Start-Sleep -Milliseconds 250
}
$processAlive = $null -ne (Get-Process -Id $activatedPid -ErrorAction SilentlyContinue)
[pscustomobject]@{
  packageVersion = [string]$package.Version
  activatedPid = [int]$activatedPid
  processAlive = $processAlive
  windowSeen = $windowSeen
  manualQuitRequired = $processAlive
} | ConvertTo-Json -Compress
