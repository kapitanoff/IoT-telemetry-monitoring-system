<#
.SYNOPSIS
    Chicken Monitor — interactive setup for Windows 7.
    Creates .env file with MQTT and database settings.
    Compatible with PowerShell 2.0.
.NOTES
    Run: .\setup-win7.ps1
    Then: cd ..\vm && .\deploy-vbox.ps1
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"

Write-Host ""
Write-Host "=== Chicken Monitor - Setup (Win7) ===" -ForegroundColor Cyan
Write-Host ""

# Check if .env already exists
if (Test-Path $EnvFile) {
    $overwrite = Read-Host ".env already exists. Overwrite? (y/N)"
    if ($overwrite -ne "y" -and $overwrite -ne "Y") {
        Write-Host "Keeping existing .env." -ForegroundColor Yellow
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
$mqttPass = Read-Host "MQTT password (leave empty if none)"

# Database password — reuse existing if .env already has one
$oldDbPass = $null
if (Test-Path $EnvFile) {
    $lines = [System.IO.File]::ReadAllLines($EnvFile)
    foreach ($line in $lines) {
        if ($line -match '^POSTGRES_PASSWORD=(.+)$') {
            $oldDbPass = $Matches[1].Trim()
            break
        }
    }
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
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  cd ..\vm" -ForegroundColor White
Write-Host "  .\deploy-vbox.ps1    (first deploy)" -ForegroundColor White
Write-Host "  .\update-vbox.ps1    (update code)" -ForegroundColor White
Write-Host ""
