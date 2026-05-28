<#
.SYNOPSIS
    Chicken Monitor — interactive setup.
    Creates .env file and starts docker compose.
.NOTES
    Run: .\setup.ps1
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"
$EnvExample = Join-Path $ScriptDir ".env.example"

Write-Host ""
Write-Host "=== Chicken Monitor - Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check if .env already exists
if (Test-Path $EnvFile) {
    $overwrite = Read-Host ".env already exists. Overwrite? (y/N)"
    if ($overwrite -ne "y" -and $overwrite -ne "Y") {
        Write-Host "Keeping existing .env. Starting..." -ForegroundColor Yellow
        Set-Location $ScriptDir
        & docker compose up -d --build
        Write-Host ""
        Write-Host "Done! Open http://localhost:8000" -ForegroundColor Green
        exit 0
    }
}

# MQTT settings
Write-Host "--- MQTT Broker ---" -ForegroundColor Yellow
do {
    $mqttHost = Read-Host "MQTT broker IP address"
    if (-not $mqttHost) { Write-Host "  IP address cannot be empty." -ForegroundColor Red }
} while (-not $mqttHost)

$mqttPort = Read-Host "MQTT port [1883]"
if (-not $mqttPort) { $mqttPort = "1883" }

$mqttUser = Read-Host "MQTT username (leave empty if none)"
$mqttPassSecure = Read-Host "MQTT password (leave empty if none)" -AsSecureString
$mqttPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($mqttPassSecure)
)

# Database password — reuse existing if .env already has one
$oldDbPass = $null
if (Test-Path $EnvFile) {
    $oldLine = Get-Content $EnvFile | Where-Object { $_ -match '^POSTGRES_PASSWORD=' }
    if ($oldLine) { $oldDbPass = ($oldLine -replace '^POSTGRES_PASSWORD=', '').Trim() }
}

Write-Host ""
Write-Host "--- Database ---" -ForegroundColor Yellow
if ($oldDbPass) {
    Write-Host "  PostgreSQL password preserved from existing .env" -ForegroundColor Gray
    $dbPass = $oldDbPass
} else {
    $dbPass = Read-Host "PostgreSQL password [auto-generate]"
    if (-not $dbPass) {
        $bytes = New-Object byte[] 12
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        $rng.GetBytes($bytes)
        $rng.Dispose()
        $dbPass = [Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', ''
        $dbPass = $dbPass.Substring(0, [Math]::Min(16, $dbPass.Length))
        Write-Host "  Generated password: $dbPass" -ForegroundColor Gray
    }
}

# Temperature thresholds
Write-Host ""
Write-Host "--- Temperature thresholds (press Enter for defaults) ---" -ForegroundColor Yellow
$tempMin = Read-Host "Normal min [40.0]"
if (-not $tempMin) { $tempMin = "40.0" }
$tempMax = Read-Host "Normal max [42.0]"
if (-not $tempMax) { $tempMax = "42.0" }
$tempWarn = Read-Host "Warning max [43.0]"
if (-not $tempWarn) { $tempWarn = "43.0" }

# Write .env
$envContent = @"
MQTT_HOST=$mqttHost
MQTT_PORT=$mqttPort
MQTT_USERNAME=$mqttUser
MQTT_PASSWORD=$mqttPass

POSTGRES_USER=chicken
POSTGRES_PASSWORD=$dbPass
POSTGRES_DB=chicken_monitor
DATABASE_URL=postgresql+psycopg://chicken:${dbPass}@localhost/chicken_monitor

TEMP_GREEN_MIN=$tempMin
TEMP_GREEN_MAX=$tempMax
TEMP_YELLOW_MAX=$tempWarn
"@

[System.IO.File]::WriteAllText($EnvFile, $envContent, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host ".env created!" -ForegroundColor Green
Write-Host ""

# Start
$startNow = Read-Host "Start Chicken Monitor now? (Y/n)"
if ($startNow -ne "n" -and $startNow -ne "N") {
    Set-Location $ScriptDir
    & docker compose up -d --build
    Write-Host ""
    Write-Host "Done! Open http://localhost:8000" -ForegroundColor Green
}
