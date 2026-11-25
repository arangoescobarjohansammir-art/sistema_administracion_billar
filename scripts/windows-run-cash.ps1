param([Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $project 'data\logs'
[void](New-Item -ItemType Directory -Path $logs -Force)

try {
    $server = Start-Process -FilePath $NodePath -ArgumentList '--env-file-if-exists=.env', 'dist/server/index.js' `
        -WorkingDirectory $project -WindowStyle Hidden -Wait -PassThru `
        -RedirectStandardOutput (Join-Path $logs 'caja.log') -RedirectStandardError (Join-Path $logs 'caja-error.log')
    exit $server.ExitCode
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $logs 'caja-error.log') -Encoding UTF8
    exit 1
}
