param(
  [ValidateRange(5, 45)]
  [int]$Seconds = 30
)

$ErrorActionPreference = 'Stop'

# This is a single-run, read-only renderer discovery probe. It intentionally
# leaves the official application running for the user to quit normally.
if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
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
$applicationEntries = @($manifest.Package.Applications.Application)
$mainApplications = @($applicationEntries | Where-Object { [string]$_.Id -ceq 'App' })
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

public static class CodexPackageActivationProbe {
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

# Reserve an OS-selected loopback port long enough to obtain the number, then
# release it immediately before activation. Abort if another PID wins the race.
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$port = ([Net.IPEndPoint]$reservation.LocalEndpoint).Port
$reservation.Stop()

$arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
$appUserModelId = "$($package.PackageFamilyName)!$($mainApplications[0].Id)"
$activatedPid = [CodexPackageActivationProbe]::Activate($appUserModelId, $arguments)
$started = Get-Date
$windowSeen = $false
$cdpReady = $false
$targetCount = 0
$pageCount = 0
$appPageCount = 0
$listenerMismatch = $false
$processExited = $false

while (((Get-Date) - $started).TotalSeconds -lt $Seconds) {
  $process = Get-Process -Id $activatedPid -ErrorAction SilentlyContinue
  if ($null -eq $process) { $processExited = $true; break }
  if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windowSeen = $true }

  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $listener) {
    if ([int]$listener.OwningProcess -ne [int]$activatedPid) {
      $listenerMismatch = $true
      break
    }
    try {
      $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2)
      $cdpReady = $true
      $targetCount = $targets.Count
      $pageCount = @($targets | Where-Object { $_.type -eq 'page' }).Count
      $appPageCount = @($targets | Where-Object { $_.type -eq 'page' -and
          [string]$_.url -like 'app://-*' }).Count
      break
    } catch {
      # The verified listener may exist before its read-only target endpoint.
    }
  }
  Start-Sleep -Milliseconds 500
}

[pscustomobject]@{
  packageVersion = [string]$package.Version
  applicationEntryCount = $applicationEntries.Count
  activatedPid = [int]$activatedPid
  windowSeen = $windowSeen
  cdpReady = $cdpReady
  targetCount = $targetCount
  pageCount = $pageCount
  appPageCount = $appPageCount
  listenerMismatch = $listenerMismatch
  processExited = $processExited
  elapsedSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  manualQuitRequired = -not $processExited
} | ConvertTo-Json -Compress
