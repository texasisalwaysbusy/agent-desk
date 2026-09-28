param([switch]$PreflightOnly, [switch]$SidebarDiagnosticOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop |
  Where-Object {
    $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' -and
    [string]$_.SignatureKind -eq 'Store'
  } | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $package) { throw 'Official registered Codex Store package not found.' }
$appPath = Join-Path ([string]$package.InstallLocation) 'app\ChatGPT.exe'
$corePath = Join-Path ([string]$package.InstallLocation) 'app\resources\codex.exe'
foreach ($file in @($appPath, $corePath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
      [string](Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid') {
    throw 'Official package executable signature invalid.'
  }
}
if ($PreflightOnly) {
  [pscustomobject]@{
    candidate = 'source-only'
    packageVersion = [string]$package.Version
    signaturesValid = $true
    codexLaunched = $false
  } | ConvertTo-Json -Compress
  return
}
if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
  throw 'Exit Codex normally before starting the source-test candidate.'
}

$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$servicePort = ([Net.IPEndPoint]$reservation.LocalEndpoint).Port
$reservation.Stop()

$env:AGENT_DESK_LOOPBACK_CANDIDATE = '1'
$env:CODEX_TASKBOARD_CODEX_VERSION = [string]$package.Version
$env:CODEX_TASKBOARD_DATA_DIR = Join-Path $projectRoot '.data\loopback-candidate\data'
$env:CODEX_TASKBOARD_RUNTIME_FILE = Join-Path $projectRoot '.data\loopback-candidate\runtime\launcher-runtime.json'
$env:CODEX_TASKBOARD_HOST = '127.0.0.1'
$env:CODEX_TASKBOARD_PORT = [string]$servicePort
$env:CODEX_TASKBOARD_VERSION = [string](Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$env:HOST = '127.0.0.1'
Remove-Item Env:CODEX_TASKBOARD_LISTEN_FD -ErrorAction SilentlyContinue

Push-Location $projectRoot
try {
  $injectorArgs = @('scripts/codex-injector.mjs', '--launch', '--watch', '--windows-loopback-candidate', '--app-path', $appPath)
  if ($SidebarDiagnosticOnly) { $injectorArgs += '--sidebar-diagnostic-only' }
  else { $injectorArgs += '--open' }
  & node @injectorArgs
  if ($LASTEXITCODE -ne 0) { throw "Candidate exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}
