param(
    [Parameter(Mandatory = $true)]
    [int]$Sensors,

    [int]$DurationSeconds = 600,

    [string]$RunName = "load_probe_20260531",

    [int]$Qos = 1
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runRoot = Join-Path $PSScriptRoot $RunName
$scenarioName = ("{0:D2}_qos{1}_{2}sensors" -f $Sensors, $Qos, $Sensors)
$scenarioDir = Join-Path $runRoot $scenarioName
$progressPath = Join-Path $scenarioDir "progress.json"

New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null

function Write-ProgressState {
    param(
        [string]$Status,
        [hashtable]$Extra = @{}
    )

    $state = [ordered]@{
        status = $Status
        sensors = $Sensors
        qos = $Qos
        duration_seconds = $DurationSeconds
        updated_at = (Get-Date).ToString("o")
        scenario_dir = $scenarioDir
    }
    foreach ($key in $Extra.Keys) {
        $state[$key] = $Extra[$key]
    }
    $state | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path $progressPath
}

function Save-Text {
    param(
        [string]$Path,
        [string]$Text
    )
    $Text | Set-Content -Encoding UTF8 -Path $Path
}

function Invoke-LoggedDocker {
    param(
        [string[]]$Arguments,
        [string]$LogPath
    )

    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker @Arguments *>&1 | Tee-Object -FilePath $LogPath | Out-Null
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw ("docker {0} failed with exit code {1}" -f ($Arguments -join " "), $exitCode)
    }
}

Push-Location $projectRoot
try {
    Write-ProgressState "starting" @{ message = "Preparing clean docker compose run" }

    $config = [ordered]@{
        sensors = $Sensors
        mqtt_qos = $Qos
        emu_qos = $Qos
        emu_interval = 5
        emu_loss = 0
        duration_seconds = $DurationSeconds
        netem = $null
        started_by = "run_single_load_probe.ps1"
        created_at = (Get-Date).ToString("o")
    }
    $config | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path (Join-Path $scenarioDir "config.json")

    $env:MQTT_QOS = [string]$Qos
    $env:EMU_QOS = [string]$Qos
    $env:EMU_SENSORS = [string]$Sensors
    $env:EMU_INTERVAL = "5"
    $env:EMU_LOSS = "0"

    Write-ProgressState "docker_down" @{ message = "Stopping previous compose stack and removing volumes" }
    Invoke-LoggedDocker -Arguments @("compose", "--profile", "emulator", "down", "-v") -LogPath (Join-Path $scenarioDir "docker-down.log")

    Write-ProgressState "docker_up" @{ message = "Starting compose stack" }
    Invoke-LoggedDocker -Arguments @("compose", "--profile", "emulator", "up", "-d", "--build") -LogPath (Join-Path $scenarioDir "docker-up.log")

    Write-ProgressState "waiting_api" @{ message = "Waiting for backend API" }
    $deadline = (Get-Date).AddMinutes(4)
    $apiReady = $false
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-RestMethod -Uri "http://localhost:8000/api/qos/time" -TimeoutSec 3 | Out-Null
            $apiReady = $true
            break
        }
        catch {
            Start-Sleep -Seconds 3
        }
    }
    if (-not $apiReady) {
        throw "Backend API did not become ready"
    }

    Write-ProgressState "warming_up" @{ message = "Giving emulator time to calibrate and start publishing" }
    Start-Sleep -Seconds 20

    $measurementStartedAt = Get-Date
    Write-ProgressState "measuring" @{
        measurement_started_at = $measurementStartedAt.ToString("o")
        elapsed_seconds = 0
        remaining_seconds = $DurationSeconds
    }

    for ($elapsed = 0; $elapsed -lt $DurationSeconds; $elapsed += 10) {
        Start-Sleep -Seconds ([Math]::Min(10, $DurationSeconds - $elapsed))
        $nowElapsed = [Math]::Min($DurationSeconds, $elapsed + 10)
        Write-ProgressState "measuring" @{
            measurement_started_at = $measurementStartedAt.ToString("o")
            elapsed_seconds = $nowElapsed
            remaining_seconds = [Math]::Max(0, $DurationSeconds - $nowElapsed)
        }
    }

    Write-ProgressState "collecting_metrics" @{ message = "Reading QoS summary from API" }
    $summary = Invoke-RestMethod -Uri "http://localhost:8000/api/qos/summary?hours=1" -TimeoutSec 10
    $summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path (Join-Path $scenarioDir "metrics.json")

    try {
        $byChicken = Invoke-RestMethod -Uri "http://localhost:8000/api/qos/by-chicken?hours=1" -TimeoutSec 20
        $byChicken | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path (Join-Path $scenarioDir "metrics_by_chicken.json")
    }
    catch {
        Save-Text -Path (Join-Path $scenarioDir "metrics_by_chicken_error.txt") -Text $_.Exception.Message
    }

    Invoke-LoggedDocker -Arguments @("compose", "ps") -LogPath (Join-Path $scenarioDir "docker-ps.txt")
    Invoke-LoggedDocker -Arguments @("compose", "logs", "--no-color", "--tail=300", "backend") -LogPath (Join-Path $scenarioDir "backend.log")
    Invoke-LoggedDocker -Arguments @("compose", "logs", "--no-color", "--tail=300", "emulator") -LogPath (Join-Path $scenarioDir "emulator.log")
    Invoke-LoggedDocker -Arguments @("compose", "logs", "--no-color", "--tail=200", "mosquitto") -LogPath (Join-Path $scenarioDir "mosquitto.log")

    $row = [ordered]@{
        sensors = $Sensors
        qos = $Qos
        avg_latency_ms = $summary.avg_latency_ms
        p95_latency_ms = $summary.p95_latency_ms
        packet_loss_percent = [Math]::Round([double]$summary.packet_loss_rate * 100, 2)
        total_messages = $summary.total_messages
        measured_at = (Get-Date).ToString("o")
        scenario_dir = $scenarioDir
    }
    $row | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path (Join-Path $scenarioDir "summary_row.json")

    Write-ProgressState "metrics_collected_waiting_for_screenshot" @{
        avg_latency_ms = $summary.avg_latency_ms
        p95_latency_ms = $summary.p95_latency_ms
        packet_loss_rate = $summary.packet_loss_rate
        total_messages = $summary.total_messages
        message = "Dashboard is still running for screenshot capture"
    }
}
catch {
    Write-ProgressState "failed" @{ error = $_.Exception.Message }
    try {
        Invoke-LoggedDocker -Arguments @("compose", "ps") -LogPath (Join-Path $scenarioDir "docker-ps-on-error.txt")
        Invoke-LoggedDocker -Arguments @("compose", "logs", "--no-color", "--tail=300") -LogPath (Join-Path $scenarioDir "docker-logs-on-error.txt")
    }
    catch {
        # Keep original failure.
    }
    throw
}
finally {
    Pop-Location
}
