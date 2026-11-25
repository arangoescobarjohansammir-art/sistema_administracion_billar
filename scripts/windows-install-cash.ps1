$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskName = 'Caja Patio Bonito - ' + $identity.User.Value
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.Actions.WorkingDirectory -ne $project) {
    throw 'Ya hay un inicio automatico para otra carpeta de caja con este usuario de Windows.'
}

Push-Location -LiteralPath $project
try {
    & $node -e 'const [major, minor] = process.versions.node.split(String.fromCharCode(46)).map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Necesitas Node.js 22.12 o posterior.' }
    if (!(Test-Path -LiteralPath 'node_modules\.bin\vite.cmd')) {
        & $npm ci
        if ($LASTEXITCODE -ne 0) { throw 'No se instalaron las dependencias.' }
    }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar la caja.' }
    $port = & $node --env-file-if-exists=.env -e 'console.log(Number(process.env.PORT ?? 4173))'
    if ($LASTEXITCODE -ne 0 -or $port -notmatch '^[0-9]+$' -or [int]$port -lt 1 -or [int]$port -gt 65535) {
        throw 'Configura un puerto local valido en .env.'
    }
} finally {
    Pop-Location
}

$runner = Join-Path $PSScriptRoot 'windows-run-cash.ps1'
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "{0}" -NodePath "{1}"' -f $runner, $node
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Inicia la caja del Club de Tejo Patio Bonito al entrar en Windows.' -Force | Out-Null

$url = "http://127.0.0.1:$port/"
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if ($desktop -and (Test-Path -LiteralPath $desktop -PathType Container)) {
    $shortcut = Join-Path $desktop 'Caja Patio Bonito.url'
    Set-Content -LiteralPath $shortcut -Value @('[InternetShortcut]', "URL=$url") -Encoding ASCII
    Write-Output 'Acceso directo creado en el escritorio: Caja Patio Bonito.'
}

if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
    if (Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue) {
        Write-Output 'El puerto ya esta en uso. El inicio automatico quedo registrado para el siguiente inicio de Windows.'
        return
    }
    Start-ScheduledTask -TaskName $taskName
}
Write-Output "Inicio automatico configurado. Abre $url"
