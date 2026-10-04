param(
  [Parameter(Mandatory=$true)][string]$HelperFile,
  [Parameter(Mandatory=$true)][string]$StubAssembly,
  [Parameter(Mandatory=$true)][string]$Scenario
)
$ErrorActionPreference = 'Stop'
# Historical helpers have no trap; preserve -File failure exit semantics even
# though the fixture dot-sources them to retain the production script scope.
trap { exit 1 }
# Execute the entire production helper with OS boundaries replaced. The only
# loaded activation type is a compiled fixture: it contains no COM or app start.
$null = [Reflection.Assembly]::LoadFrom($StubAssembly)
[AgentDeskRegisteredActivation]::Fail = $Scenario -ceq 'activation-error'
$script:fixtureRoot = Join-Path $PSScriptRoot 'fixture-package'
$script:fixtureApp = Join-Path $script:fixtureRoot 'app\ChatGPT.exe'
$script:fixtureScenario = $Scenario
$script:fixtureClock = [datetime]'2026-01-01T00:00:00Z'
$script:fixtureListeners = 0
$script:fixtureProcessReads = 0
function Get-AppxPackage {
  [CmdletBinding()] param([string]$Name)
  if ($script:fixtureScenario -ceq 'package-missing') { return }
  [pscustomobject]@{PackageFamilyName='OpenAI.Codex_2p2nqsd0c76g0';SignatureKind='Store';Version='26.928.1915.0';InstallLocation=$script:fixtureRoot}
}
function Get-Content {
  [CmdletBinding()] param([string]$LiteralPath,[switch]$Raw)
  if ($LiteralPath -cne (Join-Path $script:fixtureRoot 'AppxManifest.xml')) { throw 'Fixture file access refused.' }
  $version = if ($script:fixtureScenario -ceq 'identity-mismatch') { '26.928.1914.0' } else { '26.928.1915.0' }
  '<Package><Identity Name="OpenAI.Codex" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" Version="' + $version + '"/><Applications><Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication"/></Applications></Package>'
}
function Test-Path {
  [CmdletBinding()] param([string]$LiteralPath,[string]$PathType)
  $LiteralPath.StartsWith($script:fixtureRoot,[StringComparison]::OrdinalIgnoreCase)
}
function Get-AuthenticodeSignature {
  [CmdletBinding()] param([string]$LiteralPath)
  [pscustomobject]@{Status=$(if ($script:fixtureScenario -ceq 'signature-invalid') { 'NotSigned' } else { 'Valid' })}
}
function Add-Type {
  [CmdletBinding()] param([string]$TypeDefinition)
  if (-not $TypeDefinition.Contains('IApplicationActivationManager') -or -not $TypeDefinition.Contains('AgentDeskRegisteredActivation')) { throw 'Unexpected activation source.' }
  # Never compile or invoke the real COM activation implementation.
}
function Get-Process {
  [CmdletBinding()] param([string]$Name,[int]$Id)
  if ($Name) {
    if ($script:fixtureScenario -ceq 'codex-running') { [pscustomobject]@{Id=4242} }
    return
  }
  [Console]::Error.WriteLine('fixture-process-read')
  $script:fixtureProcessReads++
  if ($script:fixtureScenario -ceq 'process-not-visible') { return }
  if ($script:fixtureScenario -ceq 'process-read-error') { throw 'private-fixture-exception' }
  $image = switch ($script:fixtureScenario) {
    'process-path-delayed' { if($script:fixtureProcessReads -lt 4){''}else{$script:fixtureApp} }
    'process-path-delayed-mismatch' { if($script:fixtureProcessReads -lt 4){''}else{Join-Path $script:fixtureRoot 'different.exe'} }
    'process-path-unavailable' { '' }
    'path-mismatch' { Join-Path $script:fixtureRoot 'different.exe' }
    default { $script:fixtureApp }
  }
  [pscustomobject]@{Id=4242;Path=$image}
}
function Get-NetTCPConnection {
  [CmdletBinding()] param([int]$LocalPort,[string]$State)
  $script:fixtureListeners++
  if ($script:fixtureListeners -eq 1) {
    if ($script:fixtureScenario -ceq 'port-taken') { [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=9999} }
    return
  }
  if ($script:fixtureScenario -ceq 'listener-timeout') { return }
  if ($script:fixtureScenario -ceq 'listener-delayed' -and $script:fixtureListeners -lt 5) { return }
  $address = if ($script:fixtureScenario -ceq 'listener-address') { '0.0.0.0' } else { '127.0.0.1' }
  $owner = if ($script:fixtureScenario -ceq 'listener-owner') { 9999 } else { 4242 }
  [pscustomobject]@{LocalAddress=$address;OwningProcess=$owner}
  if ($script:fixtureScenario -ceq 'listener-multiple') { [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=4242} }
}
function Get-Date { $script:fixtureClock }
function Start-Sleep { param([int]$Milliseconds) $script:fixtureClock = $script:fixtureClock.AddMilliseconds($Milliseconds) }
$source = [IO.File]::ReadAllText($HelperFile)
# Dot-source in this isolated process so $script: error metadata has the same
# scope as a production -File invocation (no nested child script scope).
. ([scriptblock]::Create($source)) -ExpectedPath $script:fixtureApp -Port 23456 -Mode launcher
