<#
.SYNOPSIS
  Switch dsh-memory-loom between a live-source install and a packaged install.

.DESCRIPTION
  Why this exists: the plugin can be installed two ways, and they fail in
  different ways that are not obvious.

  * `link:` install - pnpm symlinks the profile's node_modules entry to the
    plugin checkout, so a source edit needs no repack. But Node resolves bare
    specifiers (`zod`, `@deepseek-ai/*`) from the module's REAL path, not the
    symlink, so the plugin directory must carry its own `node_modules`. Without
    it the plugin dies at import with
    `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'`.
    This script creates that node_modules as junctions into the DSH app.

  * tarball install - production-faithful: pnpm materialises a real directory
    inside the profile, so peer dependencies resolve by walking up the profile
    tree and no junctions are needed. But every source edit requires
    `pack` + `add` again.

  Junction removal deliberately uses `cmd /c rmdir`, never `Remove-Item
  -Recurse`: on a directory junction the latter can recurse into the TARGET and
  delete the DSH app's own node_modules.

  A DSH restart is still required after a host-side source edit either way,
  because the already-running process holds the previous module in memory.

.EXAMPLE
  pwsh -File tools\dev-link.ps1                 # live-source mode, then restart DSH
.EXAMPLE
  pwsh -File tools\dev-link.ps1 -Mode pack      # packaged mode
.EXAMPLE
  pwsh -File tools\dev-link.ps1 -SkipSmoke      # skip the offline suite
#>
[CmdletBinding()]
param(
  [ValidateSet('link', 'pack')]
  [string]$Mode = 'link',

  [string]$Profile = 'web',

  # ...\resources\app of the DSH Desktop install. Auto-detected when omitted.
  [string]$AppPath = '',

  # The harness directory holding profiles/. Defaults to $env:DSH_HOME.
  [string]$DshHome = '',

  # Do everything except touching the profile (junctions only).
  [switch]$SkipProfile,

  # Skip the offline assertion suite. The suite is also how this script proves
  # module resolution actually works, so skipping it skips that check.
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$pluginName = 'dsh-memory-loom'

function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok([string]$message) { Write-Host "    $message" -ForegroundColor Green }
function Write-Warn2([string]$message) { Write-Host "    $message" -ForegroundColor Yellow }

<#
Run a native command without letting its stderr abort the script.

`$ErrorActionPreference = 'Stop'` turns a native command's stderr into a
terminating error, and the DSH desktop's pnpm wrapper prints an informational
line on stderr on the way to a successful exit - so a plain `dsh plugin add`
reported failure while having actually installed the plugin. Every native
invocation goes through here instead, and only the real exit code decides.

Returns the exit code; merged output is streamed unless -Quiet is set, and
captured into the caller's variable when -Capture is used. Note that `2>&1`
merges the streams, so captured text may include stderr lines: read the exit
code, not the text, to judge success.
#>
function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$Arguments = @(),
    [switch]$Quiet,
    [switch]$Capture
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) {
      & $FilePath @Arguments 2>&1 | Out-Null
      return $LASTEXITCODE
    }
    if ($Capture) {
      $script:NativeOutput = & $FilePath @Arguments 2>&1
      return $LASTEXITCODE
    }
    & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

# -- resolve the app, the harness home, and the node binary ------------------
if (-not $AppPath) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app'),
    (Join-Path $env:ProgramFiles 'DSH Desktop\resources\app')
  )
  $AppPath = $candidates | Where-Object { Test-Path (Join-Path $_ 'node_modules\@deepseek-ai\dsh\lib\bin.js') } | Select-Object -First 1
}
if (-not $AppPath) { throw 'Could not locate the DSH Desktop app. Pass -AppPath "<...>\resources\app".' }
$AppPath = (Resolve-Path $AppPath).Path
$binPath = Join-Path $AppPath 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$nodePath = Join-Path $AppPath 'node_modules\node\bin\node.exe'
if (-not (Test-Path $binPath)) { throw "Not a DSH app directory (missing $binPath)." }
if (-not (Test-Path $nodePath)) { $nodePath = 'node' }
Write-Step "app      : $AppPath"

if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:APPDATA 'dsh-desktop\harness' }
if (-not (Test-Path $DshHome)) { throw "Harness home not found: $DshHome. Pass -DshHome or set DSH_HOME." }
Write-Step "harness  : $DshHome"
Write-Step "profile  : $Profile"
Write-Step "mode     : $Mode"

# -- the offline suite: in link mode this is also the resolution proof -------
$junctionTargets = @('@deepseek-ai', 'zod', 'js-yaml')
$pluginModules = Join-Path $pluginRoot 'node_modules'

function Add-Junctions {
  New-Item -ItemType Directory -Force -Path $pluginModules | Out-Null
  foreach ($name in $junctionTargets) {
    $link = Join-Path $pluginModules $name
    $target = Join-Path $AppPath "node_modules\$name"
    if (-not (Test-Path $target)) { Write-Warn2 "target missing, skipped: $name"; continue }
    if (Test-Path $link) { Write-Ok "already linked: $name"; continue }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Ok "linked: $name -> $target"
  }
}

function Remove-Junctions {
  foreach ($name in $junctionTargets) {
    $link = Join-Path $pluginModules $name
    if (-not (Test-Path $link)) { continue }
    # rmdir unlinks a junction without ever touching its target.
    Invoke-Native -FilePath $env:ComSpec -Arguments @('/c', 'rmdir', $link) -Quiet | Out-Null
    Write-Ok "unlinked: $name"
  }
  if ((Test-Path $pluginModules) -and -not (Get-ChildItem $pluginModules -Force)) {
    Remove-Item $pluginModules -Force
  }
}

if ($Mode -eq 'link') { Add-Junctions } else { Add-Junctions } # pack mode needs them for the suite

if (-not $SkipSmoke) {
  Write-Step 'offline suite (also proves module resolution)'
  $smokeExit = Invoke-Native -FilePath $nodePath -Arguments @((Join-Path $pluginRoot 'tools\smoke.mjs'))
  if ($smokeExit -ne 0) { throw 'The offline suite failed. Fix that before switching install modes.' }
}

# -- choose the spec, and in pack mode produce the tarball first -------------
if ($Mode -eq 'pack') {
  Write-Step 'packing'
  $pnpm = Join-Path $AppPath 'node_modules\pnpm\bin\pnpm.cjs'
  $packExit = Invoke-Native -FilePath $nodePath -Arguments @($pnpm, 'pack', '--pack-destination', $pluginRoot) -Capture
  $packOutput = $script:NativeOutput
  if ($packExit -ne 0) { throw "pnpm pack failed with exit $packExit. Output:`n$packOutput" }
  $tarball = Get-ChildItem (Join-Path $pluginRoot "$pluginName-*.tgz") |
    Sort-Object { [version]($_.BaseName -replace "^$pluginName-", '') } |
    Select-Object -Last 1
  if (-not $tarball) { throw "pnpm pack produced no tarball. Output:`n$packOutput" }
  Write-Ok "tarball: $($tarball.Name)"
  # Junctions exist only to serve link mode; a packaged install does not need them.
  Remove-Junctions
  $spec = 'file:' + ($tarball.FullName -replace '\\', '/')
} else {
  $spec = 'link:' + $pluginRoot
}

Write-Step "profile spec: $spec"

if ($SkipProfile) {
  Write-Warn2 'profile left untouched (-SkipProfile)'
} else {
  $env:DSH_HOME = $DshHome
  $addExit = Invoke-Native -FilePath $nodePath -Arguments @($binPath, 'plugin', '--profile', $Profile, 'add', $spec)
  if ($addExit -ne 0) { throw "dsh plugin add failed with exit $addExit" }
  $manifest = Get-Content (Join-Path $DshHome "profiles\$Profile\package.json") -Raw | ConvertFrom-Json
  Write-Ok "installed: $($manifest.dependencies.$pluginName)"
  Write-Ok "in bundles: $($manifest.dsh.profile.bundles -contains $pluginName)"
}

Write-Host ''
Write-Host 'Next: restart DSH Desktop to load the change.' -ForegroundColor Cyan
if ($Mode -eq 'link') {
  Write-Host '      Host-side source edits then need only a restart - no repack.' -ForegroundColor DarkGray
  Write-Host "      Revert to a packaged install with: pwsh -File tools\dev-link.ps1 -Mode pack" -ForegroundColor DarkGray
} else {
  Write-Host '      Source edits now require re-running this script with -Mode pack.' -ForegroundColor DarkGray
}
