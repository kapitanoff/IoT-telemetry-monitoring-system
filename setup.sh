#!/bin/bash
# Chicken Monitor — interactive setup
# Creates .env file and starts docker compose

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"

echo ""
echo "=== Chicken Monitor — Setup ==="
echo ""

# Check if .env already exists
if [ -f "$ENV_FILE" ]; then
    read -p ".env already exists. Overwrite? (y/N): " overwrite
    if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
        echo "Keeping existing .env. Starting..."
        cd "$SCRIPT_DIR"
        docker compose up -d --build
        echo ""
        echo "Done! Open http://localhost:8000"
        exit 0
    fi
fi

# MQTT settings
echo "--- MQTT Broker ---"
read -p "MQTT broker IP address: " mqtt_host
while [ -z "$mqtt_host" ]; do
    echo "  IP address cannot be empty."
    read -p "MQTT broker IP address: " mqtt_host
done

read -p "MQTT port [1883]: " mqtt_port
mqtt_port="${mqtt_port:-1883}"

read -p "MQTT username (leave empty if none): " mqtt_user
read -sp "MQTT password (leave empty if none): " mqtt_pass
echo ""

# Database password — reuse existing if .env already has one
old_db_pass=""
if [ -f "$ENV_FILE" ]; then
    old_db_pass=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
fi

echo ""
echo "--- Database ---"
if [ -n "$old_db_pass" ]; then
    echo "  PostgreSQL password preserved from existing .env"
    db_pass="$old_db_pass"
else
    read -p "PostgreSQL password [auto-generate]: " db_pass
    if [ -z "$db_pass" ]; then
        db_pass=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
        echo "  Generated password: $db_pass"
    fi
fi

# Temperature thresholds
echo ""
echo "--- Temperature thresholds (press Enter for defaults) ---"
read -p "Normal min [38.0]: " temp_min
temp_min="${temp_min:-38.0}"
read -p "Normal max [41.5]: " temp_max
temp_max="${temp_max:-41.5}"
read -p "Warning max [42.5]: " temp_warn
temp_warn="${temp_warn:-42.5}"

# Write .env
cat > "$ENV_FILE" << EOF
MQTT_HOST=$mqtt_host
MQTT_PORT=$mqtt_port
MQTT_USERNAME=$mqtt_user
MQTT_PASSWORD=$mqtt_pass

POSTGRES_USER=chicken
POSTGRES_PASSWORD=$db_pass
POSTGRES_DB=chicken_monitor
DATABASE_URL=postgresql+psycopg://chicken:${db_pass}@localhost/chicken_monitor

TEMP_GREEN_MIN=$temp_min
TEMP_GREEN_MAX=$temp_max
TEMP_YELLOW_MAX=$temp_warn
EOF

echo ""
echo ".env created!"
echo ""

# Start
read -p "Start Chicken Monitor now? (Y/n): " start_now
if [ "$start_now" != "n" ] && [ "$start_now" != "N" ]; then
    cd "$SCRIPT_DIR"
    docker compose up -d --build
    echo ""
    echo "Done! Open http://localhost:8000"
fi
