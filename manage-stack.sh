#!/bin/bash

# Docker stack management script for AI Agent Stack
# Manages the AI Agent Stack Docker environment with build, start, stop, and cleanup operations.
# Handles init container cleanup and proper service startup ordering.

set -euo pipefail

# Configuration
PROJECT_NAME="ai-agent-stack"
INIT_CONTAINERS=("ssl-cert-init" "neo4j-init" "ai-agent-stack-kafka-init")
CORE_SERVICES=("neo4j" "kafka" "qdrant" "minio")
INGESTION_SERVICE="ingestion"

# ANSI color codes for rich output
declare -A COLORS=(
    ["RED"]="\033[31m"
    ["GREEN"]="\033[32m"
    ["YELLOW"]="\033[33m"
    ["BLUE"]="\033[34m"
    ["MAGENTA"]="\033[35m"
    ["CYAN"]="\033[36m"
    ["WHITE"]="\033[37m"
    ["RESET"]="\033[0m"
)

# Function to write colored output
write_color_output() {
    local message="$1"
    local color="${2:-WHITE}"
    echo -e "${COLORS[$color]}${message}${COLORS[RESET]}"
}

# Function to write header
write_header() {
    local title="$1"
    echo ""
    write_color_output "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "CYAN"
    write_color_output "  $title" "CYAN"
    write_color_output "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "CYAN"
    echo ""
}

# Function to test if Docker is running
test_docker_running() {
    if docker version &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Function to test if a service is healthy
test_service_healthy() {
    local service_name="$1"
    
    if ! command -v jq &>/dev/null; then
        # Fallback: check if container is running (no warning spam)
        if docker compose -p "$PROJECT_NAME" ps "$service_name" --format json 2>/dev/null | grep -q "running"; then
            return 0
        else
            return 1
        fi
    fi
    
    local result
    if result=$(docker compose -p "$PROJECT_NAME" ps --format json 2>/dev/null); then
        local service_info
        if service_info=$(echo "$result" | jq -r ".[] | select(.Service == \"$service_name\")"); then
            if [[ -n "$service_info" ]]; then
                local health state
                health=$(echo "$service_info" | jq -r '.Health // "none"')
                state=$(echo "$service_info" | jq -r '.State // "none"')
                
                if [[ "$health" == "healthy" ]] || [[ "$state" == "running" ]]; then
                    return 0
                fi
            fi
        fi
    fi
    return 1
}

# Function to wait for services to become healthy
wait_for_services_healthy() {
    local services=("$@")
    local timeout_seconds=300
    local start_time
    start_time=$(date +%s)
    
    write_color_output "⏳ Waiting for core services to become healthy..." "YELLOW"
    
    while true; do
        local healthy_services=()
        
        for service in "${services[@]}"; do
            if test_service_healthy "$service"; then
                healthy_services+=("$service")
            fi
        done
        
        local remaining_services=()
        for service in "${services[@]}"; do
            local found=false
            for healthy in "${healthy_services[@]}"; do
                if [[ "$service" == "$healthy" ]]; then
                    found=true
                    break
                fi
            done
            if [[ "$found" == false ]]; then
                remaining_services+=("$service")
            fi
        done
        
        if [[ ${#remaining_services[@]} -eq 0 ]]; then
            write_color_output "✅ All core services are healthy!" "GREEN"
            return 0
        fi
        
        local remaining_list
        remaining_list=$(IFS=', '; echo "${remaining_services[*]}")
        write_color_output "   Still waiting for: $remaining_list" "YELLOW"
        sleep 5
        
        local current_time elapsed
        current_time=$(date +%s)
        elapsed=$((current_time - start_time))
        
        if [[ $elapsed -ge $timeout_seconds ]]; then
            write_color_output "❌ Timeout waiting for services to become healthy" "RED"
            return 1
        fi
    done
}

# Function to remove init containers
remove_init_containers() {
    write_color_output "🧹 Cleaning up initialization containers..." "YELLOW"
    
    for container in "${INIT_CONTAINERS[@]}"; do
        if docker ps -a --format "{{.Names}}" | grep -q "^${container}$"; then
            write_color_output "   Removing container: $container" "BLUE"
            docker rm -f "$container" &>/dev/null || true
        fi
    done
    
    write_color_output "✅ Init containers cleanup completed" "GREEN"
}

# Function to build stack
invoke_build_stack() {
    write_header "🏗️ Building AI Agent Stack"
    
    if ! test_docker_running; then
        write_color_output "❌ Docker is not running. Please start Docker and try again." "RED"
        exit 1
    fi
    
    if [[ ! -f "docker-compose.yml" ]]; then
        write_color_output "❌ docker-compose.yml not found. Please run this script from the project root." "RED"
        exit 1
    fi
    
    # Temporarily disable exit on error for better error handling
    set +e
    
    write_color_output "📦 Building and starting services..." "BLUE"
    if ! docker compose -p "$PROJECT_NAME" up --build -d; then
        write_color_output "❌ Failed to build Docker stack" "RED"
        exit 1
    fi
    
    write_color_output "✅ Stack deployment initiated" "GREEN"
    
    # Wait for core services to be healthy (this ensures ingestion dependencies are ready)
    write_color_output "⏳ Waiting for core services to become healthy..." "YELLOW"
    if wait_for_services_healthy "${CORE_SERVICES[@]}"; then
        write_color_output "✅ Core services are healthy!" "GREEN"
        
        # Check if ingestion service is already running from the initial deployment
        write_color_output "🔍 Checking ingestion service status..." "BLUE"
        sleep 5  # Give it a moment to stabilize
        
        if test_service_healthy "$INGESTION_SERVICE"; then
            write_color_output "✅ Ingestion service is running" "GREEN"
        else
            write_color_output "⚠️ Ingestion service not ready yet, waiting longer..." "YELLOW"
            sleep 15
            
            if ! test_service_healthy "$INGESTION_SERVICE"; then
                write_color_output "⚠️ Ingestion service may need more time to start" "YELLOW"
                write_color_output "   This is normal for the first run or after rebuilds" "YELLOW"
            fi
        fi
        
        # Clean up init containers after everything is running
        remove_init_containers
        
    else
        write_color_output "⚠️ Some services may not be ready, but proceeding with cleanup..." "YELLOW"
        remove_init_containers
    fi
    
    write_header "🎉 Stack Build Complete"
    write_color_output "Stack Status:" "CYAN"
    if ! docker compose -p "$PROJECT_NAME" ps --format table; then
        write_color_output "⚠️ Could not display container status" "YELLOW"
    fi
    
    # Re-enable exit on error
    set -e
}

# Function to start stack
invoke_start_stack() {
    write_header "🚀 Starting AI Agent Stack"
    
    if ! test_docker_running; then
        write_color_output "❌ Docker is not running. Please start Docker and try again." "RED"
        exit 1
    fi
    
    if [[ ! -f "docker-compose.yml" ]]; then
        write_color_output "❌ docker-compose.yml not found. Please run this script from the project root." "RED"
        exit 1
    fi
    
    # Temporarily disable exit on error for better error handling
    set +e
    
    # Start core services first (excluding ingestion and init containers)
    write_color_output "📦 Starting core services..." "BLUE"
    
    # Use docker start directly on containers to avoid dependency resolution
    if ! docker start neo4j kafka minio qdrant; then
        write_color_output "⚠️ Some core services may have had issues starting" "YELLOW"
    fi
    
    # Wait for core services to be healthy
    if wait_for_services_healthy "${CORE_SERVICES[@]}"; then
        write_color_output "✅ Core services are healthy!" "GREEN"
        
        # Now start ingestion service
        write_color_output "🚀 Starting ingestion service..." "BLUE"
        if docker start ingestion; then
            # Give ingestion time to start
            write_color_output "⏳ Waiting for ingestion service to start..." "YELLOW"
            sleep 10
            
            if test_service_healthy "$INGESTION_SERVICE"; then
                write_color_output "✅ Ingestion service is running" "GREEN"
            else
                write_color_output "⚠️ Ingestion service may need more time to start" "YELLOW"
            fi
        else
            write_color_output "⚠️ Ingestion service had issues starting" "YELLOW"
        fi
    else
        write_color_output "⚠️ Some core services may not be ready" "YELLOW"
        write_color_output "🚀 Starting ingestion service anyway..." "BLUE"
        docker start ingestion
    fi
    
    write_header "🎉 Stack Start Complete"
    write_color_output "Stack Status:" "CYAN"
    if ! docker compose -p "$PROJECT_NAME" ps --format table; then
        write_color_output "⚠️ Could not display container status" "YELLOW"
    fi
    
    # Re-enable exit on error
    set -e
}

# Function to stop stack
invoke_stop_stack() {
    write_header "🛑 Stopping AI Agent Stack"
    
    write_color_output "⏹️ Stopping all services..." "YELLOW"
    if docker compose -p "$PROJECT_NAME" stop; then
        write_color_output "✅ All services stopped successfully" "GREEN"
    else
        write_color_output "⚠️ Some services may not have stopped cleanly" "YELLOW"
    fi
    
    write_color_output "Current Status:" "CYAN"
    if ! docker compose -p "$PROJECT_NAME" ps --format table; then
        write_color_output "⚠️ Could not display container status" "YELLOW"
    fi
}

# Function to clean stack
invoke_clean_stack() {
    write_header "🗑️ Cleaning AI Agent Stack"
    
    write_color_output "⚠️ WARNING: This will permanently delete all containers and data!" "RED"
    write_color_output "This action cannot be undone." "RED"
    echo ""
    
    read -p "Type 'YES' to confirm deletion: " confirmation
    
    if [[ "$confirmation" != "YES" ]]; then
        write_color_output "❌ Operation cancelled" "YELLOW"
        return
    fi
    
    write_color_output "🛑 Stopping all services..." "YELLOW"
    if ! docker compose -p "$PROJECT_NAME" down --remove-orphans; then
        write_color_output "⚠️ Some containers may not have stopped cleanly" "YELLOW"
    fi
    
    write_color_output "🗑️ Removing volumes..." "YELLOW"
    if ! docker compose -p "$PROJECT_NAME" down --volumes; then
        write_color_output "⚠️ Some volumes may not have been removed" "YELLOW"
    fi
    
    write_color_output "🧹 Cleaning up any remaining init containers..." "YELLOW"
    remove_init_containers
    
    write_color_output "🔍 Removing any orphaned containers..." "BLUE"
    local orphaned_containers
    if orphaned_containers=$(docker ps -a --filter "name=$PROJECT_NAME" --format "{{.Names}}" 2>/dev/null); then
        if [[ -n "$orphaned_containers" ]]; then
            echo "$orphaned_containers" | xargs docker rm -f
        fi
    fi
    
    write_color_output "✅ Stack cleanup completed" "GREEN"
    write_color_output "All containers and volumes have been removed" "GREEN"
}

# Function to show help
show_help() {
    write_header "🚀 AI Agent Stack Management Script"
    
    write_color_output "USAGE:" "CYAN"
    write_color_output "  ./manage-stack.sh build   # Build and start the stack" "WHITE"
    write_color_output "  ./manage-stack.sh start   # Start existing containers" "WHITE"
    write_color_output "  ./manage-stack.sh stop    # Stop all containers" "WHITE"
    write_color_output "  ./manage-stack.sh clean   # Remove containers and volumes" "WHITE"
    write_color_output "  ./manage-stack.sh help    # Show this help message" "WHITE"
    echo ""
    
    write_color_output "COMMANDS:" "CYAN"
    write_color_output "  build    Build the entire Docker stack with proper service ordering" "GREEN"
    write_color_output "           • Builds and starts all services" "WHITE"
    write_color_output "           • Waits for core services to be healthy" "WHITE"
    write_color_output "           • Starts ingestion service last" "WHITE"
    write_color_output "           • Cleans up init containers automatically" "WHITE"
    echo ""
    
    write_color_output "  start    Start existing containers in proper order" "GREEN"
    write_color_output "           • Starts core services first" "WHITE"
    write_color_output "           • Waits for core services to be healthy" "WHITE"
    write_color_output "           • Starts ingestion service last" "WHITE"
    write_color_output "           • No rebuilding - uses existing containers" "WHITE"
    echo ""
    
    write_color_output "  stop     Stop all running containers" "YELLOW"
    write_color_output "           • Gracefully stops all services" "WHITE"
    write_color_output "           • Preserves data and container state" "WHITE"
    echo ""
    
    write_color_output "  clean    Remove all containers and volumes (DESTRUCTIVE)" "RED"
    write_color_output "           • Permanently deletes all containers" "WHITE"
    write_color_output "           • Removes all Docker volumes and data" "WHITE"
    write_color_output "           • Requires confirmation" "WHITE"
    echo ""
    
    write_color_output "EXAMPLES:" "CYAN"
    write_color_output "  # Build a fresh environment" "WHITE"
    write_color_output "  ./manage-stack.sh build" "BLUE"
    echo ""
    write_color_output "  # Restart stopped services" "WHITE"
    write_color_output "  ./manage-stack.sh start" "BLUE"
    echo ""
    write_color_output "  # Stop for maintenance" "WHITE"
    write_color_output "  ./manage-stack.sh stop" "BLUE"
    echo ""
    write_color_output "  # Complete reset (removes all data)" "WHITE"
    write_color_output "  ./manage-stack.sh clean" "BLUE"
    echo ""
}

# Main execution logic
main() {
    local command="${1:-help}"
    
    case "$command" in
        "build")
            invoke_build_stack
            ;;
        "start")
            invoke_start_stack
            ;;
        "stop")
            invoke_stop_stack
            ;;
        "clean")
            invoke_clean_stack
            ;;
        "help"|"--help"|"-h")
            show_help
            ;;
        *)
            write_color_output "❌ Unknown command: $command" "RED"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# Check for dependencies
check_dependencies() {
    local missing_deps=()
    
    if ! command -v docker &>/dev/null; then
        missing_deps+=("docker")
    fi
    
    if ! command -v jq &>/dev/null; then
        write_color_output "⚠️ jq not found - health checking will use fallback method" "YELLOW"
    fi
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        write_color_output "❌ Missing required dependencies: ${missing_deps[*]}" "RED"
        write_color_output "Please install the missing dependencies and try again." "RED"
        exit 1
    fi
}

# Run dependency check and main function
check_dependencies
main "$@" 