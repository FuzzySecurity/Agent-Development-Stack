#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Docker stack management script for AI Agent Stack
.DESCRIPTION
    Manages the AI Agent Stack Docker environment with build, start, stop, and cleanup operations.
    Handles init container cleanup and proper service startup ordering.
.PARAMETER Build
    Build and start the entire Docker stack
.PARAMETER Start
    Start existing containers in proper order
.PARAMETER Stop
    Stop all running containers
.PARAMETER Clean
    Remove all containers and volumes (destructive operation)
.PARAMETER Help
    Show this help message
.EXAMPLE
    .\manage-stack.ps1 -Build
    .\manage-stack.ps1 -Start
    .\manage-stack.ps1 -Stop
    .\manage-stack.ps1 -Clean
#>

[CmdletBinding(DefaultParameterSetName = 'Help')]
param(
    [Parameter(ParameterSetName = 'Build')]
    [switch]$Build,
    
    [Parameter(ParameterSetName = 'Start')]
    [switch]$Start,
    
    [Parameter(ParameterSetName = 'Stop')]
    [switch]$Stop,
    
    [Parameter(ParameterSetName = 'Clean')]
    [switch]$Clean,
    
    [Parameter(ParameterSetName = 'Help')]
    [switch]$Help
)

# Configuration
$ProjectName = "ai-agent-stack"
$InitContainers = @("ssl-cert-init", "neo4j-init", "ai-agent-stack-kafka-init")
$CoreServices = @("neo4j", "kafka", "qdrant", "minio")
$IngestionService = "ingestion"

# ANSI color codes for rich output
$Colors = @{
    Red     = "`e[31m"
    Green   = "`e[32m"
    Yellow  = "`e[33m"
    Blue    = "`e[34m"
    Magenta = "`e[35m"
    Cyan    = "`e[36m"
    White   = "`e[37m"
    Reset   = "`e[0m"
}

function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host "$($Colors[$Color])$Message$($Colors.Reset)"
}

function Write-Header {
    param([string]$Title)
    Write-Host ""
    Write-ColorOutput "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Cyan"
    Write-ColorOutput "  $Title" "Cyan"
    Write-ColorOutput "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Cyan"
    Write-Host ""
}

function Test-DockerRunning {
    try {
        $null = docker version 2>$null
        return $true
    } catch {
        return $false
    }
}

function Test-ServiceHealthy {
    param([string]$ServiceName)
    
    try {
        $result = docker compose -p $ProjectName ps --format json | ConvertFrom-Json
        $service = $result | Where-Object { $_.Service -eq $ServiceName }
        
        if ($service) {
            return $service.Health -eq "healthy" -or $service.State -eq "running"
        }
        return $false
    } catch {
        return $false
    }
}

function Wait-ForServicesHealthy {
    param([string[]]$Services, [int]$TimeoutSeconds = 300)
    
    Write-ColorOutput "⏳ Waiting for core services to become healthy..." "Yellow"
    $startTime = Get-Date
    
    do {
        $healthyServices = @()
        foreach ($service in $Services) {
            if (Test-ServiceHealthy $service) {
                $healthyServices += $service
            }
        }
        
        $remainingServices = $Services | Where-Object { $_ -notin $healthyServices }
        
        if ($remainingServices.Count -eq 0) {
            Write-ColorOutput "✅ All core services are healthy!" "Green"
            return $true
        }
        
        Write-ColorOutput "   Still waiting for: $($remainingServices -join ', ')" "Yellow"
        Start-Sleep -Seconds 5
        
        $elapsed = (Get-Date) - $startTime
    } while ($elapsed.TotalSeconds -lt $TimeoutSeconds)
    
    Write-ColorOutput "❌ Timeout waiting for services to become healthy" "Red"
    return $false
}

function Remove-InitContainers {
    Write-ColorOutput "🧹 Cleaning up initialization containers..." "Yellow"
    
    foreach ($container in $InitContainers) {
        try {
            $containerExists = docker ps -a --format "{{.Names}}" | Where-Object { $_ -eq $container }
            if ($containerExists) {
                Write-ColorOutput "   Removing container: $container" "Blue"
                docker rm -f $container 2>$null
            }
        } catch {
            Write-ColorOutput "   Warning: Could not remove $container" "Yellow"
        }
    }
    
    Write-ColorOutput "✅ Init containers cleanup completed" "Green"
}

function Invoke-BuildStack {
    Write-Header "🏗️ Building AI Agent Stack"
    
    if (-not (Test-DockerRunning)) {
        Write-ColorOutput "❌ Docker is not running. Please start Docker Desktop and try again." "Red"
        exit 1
    }
    
    if (-not (Test-Path "docker-compose.yml")) {
        Write-ColorOutput "❌ docker-compose.yml not found. Please run this script from the project root." "Red"
        exit 1
    }
    
    try {
        Write-ColorOutput "📦 Building and starting services..." "Blue"
        docker compose -p $ProjectName up --build -d
        
        if ($LASTEXITCODE -ne 0) {
            Write-ColorOutput "❌ Failed to build Docker stack" "Red"
            exit 1
        }
        
        Write-ColorOutput "✅ Stack deployment initiated" "Green"
        
        # Wait for core services to be healthy (this ensures ingestion dependencies are ready)
        Write-ColorOutput "⏳ Waiting for core services to become healthy..." "Yellow"
        if (Wait-ForServicesHealthy $CoreServices) {
            Write-ColorOutput "✅ Core services are healthy!" "Green"
            
            # Check if ingestion service is already running from the initial deployment
            Write-ColorOutput "🔍 Checking ingestion service status..." "Blue"
            Start-Sleep -Seconds 5  # Give it a moment to stabilize
            
            if (Test-ServiceHealthy $IngestionService) {
                Write-ColorOutput "✅ Ingestion service is running" "Green"
            } else {
                Write-ColorOutput "⚠️ Ingestion service not ready yet, waiting longer..." "Yellow"
                Start-Sleep -Seconds 15
                
                if (-not (Test-ServiceHealthy $IngestionService)) {
                    Write-ColorOutput "⚠️ Ingestion service may need more time to start" "Yellow"
                    Write-ColorOutput "   This is normal for the first run or after rebuilds" "Yellow"
                }
            }
            
            # Clean up init containers after everything is running
            Remove-InitContainers
            
        } else {
            Write-ColorOutput "⚠️ Some services may not be ready, but proceeding with cleanup..." "Yellow"
            Remove-InitContainers
        }
        
        Write-Header "🎉 Stack Build Complete"
        Write-ColorOutput "Stack Status:" "Cyan"
        docker compose -p $ProjectName ps --format table
        
    } catch {
        Write-ColorOutput "❌ Error during stack build: $($_.Exception.Message)" "Red"
        exit 1
    }
}

function Invoke-StartStack {
    Write-Header "🚀 Starting AI Agent Stack"
    
    if (-not (Test-DockerRunning)) {
        Write-ColorOutput "❌ Docker is not running. Please start Docker Desktop and try again." "Red"
        exit 1
    }
    
    if (-not (Test-Path "docker-compose.yml")) {
        Write-ColorOutput "❌ docker-compose.yml not found. Please run this script from the project root." "Red"
        exit 1
    }
    
    try {
        # Start core services first (excluding ingestion and init containers)
        Write-ColorOutput "📦 Starting core services..." "Blue"
        
        # Use docker start directly on containers to avoid dependency resolution
        docker start neo4j kafka minio qdrant
        
        if ($LASTEXITCODE -ne 0) {
            Write-ColorOutput "⚠️ Some core services may have had issues starting" "Yellow"
        }
        
        # Wait for core services to be healthy
        if (Wait-ForServicesHealthy $CoreServices) {
            Write-ColorOutput "✅ Core services are healthy!" "Green"
            
            # Now start ingestion service
            Write-ColorOutput "🚀 Starting ingestion service..." "Blue"
            docker start ingestion
            
            if ($LASTEXITCODE -eq 0) {
                # Give ingestion time to start
                Write-ColorOutput "⏳ Waiting for ingestion service to start..." "Yellow"
                Start-Sleep -Seconds 10
                
                if (Test-ServiceHealthy $IngestionService) {
                    Write-ColorOutput "✅ Ingestion service is running" "Green"
                } else {
                    Write-ColorOutput "⚠️ Ingestion service may need more time to start" "Yellow"
                }
            } else {
                Write-ColorOutput "⚠️ Ingestion service had issues starting" "Yellow"
            }
        } else {
            Write-ColorOutput "⚠️ Some core services may not be ready" "Yellow"
            Write-ColorOutput "🚀 Starting ingestion service anyway..." "Blue"
            docker start ingestion
        }
        
        Write-Header "🎉 Stack Start Complete"
        Write-ColorOutput "Stack Status:" "Cyan"
        docker compose -p $ProjectName ps --format table
        
    } catch {
        Write-ColorOutput "❌ Error starting stack: $($_.Exception.Message)" "Red"
        exit 1
    }
}

function Invoke-StopStack {
    Write-Header "🛑 Stopping AI Agent Stack"
    
    try {
        Write-ColorOutput "⏹️ Stopping all services..." "Yellow"
        docker compose -p $ProjectName stop
        
        if ($LASTEXITCODE -eq 0) {
            Write-ColorOutput "✅ All services stopped successfully" "Green"
        } else {
            Write-ColorOutput "⚠️ Some services may not have stopped cleanly" "Yellow"
        }
        
        Write-ColorOutput "Current Status:" "Cyan"
        docker compose -p $ProjectName ps --format table
        
    } catch {
        Write-ColorOutput "❌ Error stopping stack: $($_.Exception.Message)" "Red"
        exit 1
    }
}

function Invoke-CleanStack {
    Write-Header "🗑️ Cleaning AI Agent Stack"
    
    Write-ColorOutput "⚠️ WARNING: This will permanently delete all containers and data!" "Red"
    Write-ColorOutput "This action cannot be undone." "Red"
    Write-Host ""
    
    $confirmation = Read-Host "Type 'YES' to confirm deletion"
    
    if ($confirmation -ne "YES") {
        Write-ColorOutput "❌ Operation cancelled" "Yellow"
        return
    }
    
    try {
        Write-ColorOutput "🛑 Stopping all services..." "Yellow"
        docker compose -p $ProjectName down --remove-orphans
        
        Write-ColorOutput "🗑️ Removing volumes..." "Yellow"
        docker compose -p $ProjectName down --volumes
        
        Write-ColorOutput "🧹 Cleaning up any remaining init containers..." "Yellow"
        Remove-InitContainers
        
        Write-ColorOutput "🔍 Removing any orphaned containers..." "Blue"
        $orphanedContainers = docker ps -a --filter "name=$ProjectName" --format "{{.Names}}"
        if ($orphanedContainers) {
            docker rm -f $orphanedContainers
        }
        
        Write-ColorOutput "✅ Stack cleanup completed" "Green"
        Write-ColorOutput "All containers and volumes have been removed" "Green"
        
    } catch {
        Write-ColorOutput "❌ Error during cleanup: $($_.Exception.Message)" "Red"
        exit 1
    }
}

function Show-Help {
    Write-Header "🚀 AI Agent Stack Management Script"
    
    Write-ColorOutput "USAGE:" "Cyan"
    Write-ColorOutput "  .\manage-stack.ps1 -Build   # Build and start the stack" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Start   # Start existing containers" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Stop    # Stop all containers" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Clean   # Remove containers and volumes" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Help    # Show this help message" "White"
    Write-Host ""
    
    Write-ColorOutput "COMMANDS:" "Cyan"
    Write-ColorOutput "  -Build   Build the entire Docker stack with proper service ordering" "Green"
    Write-ColorOutput "           • Builds and starts all services" "White"
    Write-ColorOutput "           • Waits for core services to be healthy" "White"
    Write-ColorOutput "           • Starts ingestion service last" "White"
    Write-ColorOutput "           • Cleans up init containers automatically" "White"
    Write-Host ""
    
    Write-ColorOutput "  -Start   Start existing containers in proper order" "Green"
    Write-ColorOutput "           • Starts core services first" "White"
    Write-ColorOutput "           • Waits for core services to be healthy" "White"
    Write-ColorOutput "           • Starts ingestion service last" "White"
    Write-ColorOutput "           • No rebuilding - uses existing containers" "White"
    Write-Host ""
    
    Write-ColorOutput "  -Stop    Stop all running containers" "Yellow"
    Write-ColorOutput "           • Gracefully stops all services" "White"
    Write-ColorOutput "           • Preserves data and container state" "White"
    Write-Host ""
    
    Write-ColorOutput "  -Clean   Remove all containers and volumes (DESTRUCTIVE)" "Red"
    Write-ColorOutput "           • Permanently deletes all containers" "White"
    Write-ColorOutput "           • Removes all Docker volumes and data" "White"
    Write-ColorOutput "           • Requires confirmation" "White"
    Write-Host ""
    
    Write-ColorOutput "EXAMPLES:" "Cyan"
    Write-ColorOutput "  # Build a fresh environment" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Build" "Blue"
    Write-Host ""
    Write-ColorOutput "  # Restart stopped services" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Start" "Blue"
    Write-Host ""
    Write-ColorOutput "  # Stop for maintenance" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Stop" "Blue"
    Write-Host ""
    Write-ColorOutput "  # Complete reset (removes all data)" "White"
    Write-ColorOutput "  .\manage-stack.ps1 -Clean" "Blue"
    Write-Host ""
}

# Main execution logic
switch ($PSCmdlet.ParameterSetName) {
    'Build' { Invoke-BuildStack }
    'Start' { Invoke-StartStack }
    'Stop'  { Invoke-StopStack }
    'Clean' { Invoke-CleanStack }
    'Help'  { Show-Help }
    default { Show-Help }
} 