import json
import time
import logging
import threading
import paho.mqtt.client as mqtt
from datetime import datetime, timezone
from sqlalchemy.dialects.postgresql import insert as pg_insert
from database import SessionLocal
from models import Chicken, TemperatureReading, QosMetric
from config import settings
from utils import is_valid_chicken_id

logger = logging.getLogger(__name__)


def _parse_payload(raw: bytes):
    """
    Parse MQTT payload. Supports two formats:
    - New JSON: {"value": 41.2, "sent_ts": 1234567890.123, "seq_id": 42}
    - Old plain float: "41.2"
    Returns (value, sent_ts, seq_id). sent_ts and seq_id are None for old format.
    """
    text = raw.decode("utf-8").strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "value" in data:
            return float(data["value"]), data.get("sent_ts"), data.get("seq_id")
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    return float(text), None, None


def on_message(client, userdata, msg):
    try:
        value, sent_ts, seq_id = _parse_payload(msg.payload)
    except ValueError:
        logger.warning("Unparseable MQTT payload on %s: %r", msg.topic, msg.payload[:200])
        return

    parts = msg.topic.split("/")
    if len(parts) != 3 or parts[0] != settings.MQTT_TOPIC_PREFIX:
        return

    _, chicken_id, data_type = parts

    if not is_valid_chicken_id(chicken_id):
        logger.warning("Invalid chicken_id from MQTT: %r", chicken_id)
        return

    db = SessionLocal()
    try:
        db.execute(
            pg_insert(Chicken).values(chicken_id=chicken_id).on_conflict_do_nothing()
        )
        db.flush()
        chicken = db.query(Chicken).filter(Chicken.chicken_id == chicken_id).first()

        if data_type == "Temperature":
            chicken.last_temperature = value
            chicken.last_seen = datetime.now(timezone.utc)

            reading = TemperatureReading(
                chicken_id=chicken_id,
                temperature=value,
                voltage=chicken.voltage
            )
            db.add(reading)

            if sent_ts is not None and seq_id is not None:
                received_ts = time.time()
                latency_ms = max((received_ts - sent_ts) * 1000, 0.0)
                metric = QosMetric(
                    chicken_id=chicken_id,
                    seq_id=int(seq_id),
                    sent_ts=sent_ts,
                    received_ts=received_ts,
                    latency_ms=latency_ms,
                    qos_level=settings.MQTT_QOS,
                )
                db.add(metric)

            db.commit()

        elif data_type == "voltage":
            chicken.voltage = value
            chicken.last_seen = datetime.now(timezone.utc)
            db.commit()

    except Exception as e:
        db.rollback()
        logger.exception("DB error processing MQTT message: %s", e)
    finally:
        db.close()


def _reconnect_loop(client):
    delay = 1
    while True:
        try:
            client.reconnect()
            logger.info("MQTT reconnected successfully")
            break
        except Exception as e:
            logger.warning("MQTT reconnect failed: %s, retrying in %ds...", e, delay)
            time.sleep(delay)
            delay = min(delay * 2, 60)


def on_disconnect(client, userdata, rc):
    if rc != 0:
        logger.warning("MQTT disconnected unexpectedly (rc=%d), reconnecting...", rc)
        threading.Thread(target=_reconnect_loop, args=(client,), daemon=True).start()


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        logger.info("Connected to MQTT broker %s", settings.MQTT_HOST)
        client.subscribe(f"{settings.MQTT_TOPIC_PREFIX}/+/Temperature", qos=settings.MQTT_QOS)
        client.subscribe(f"{settings.MQTT_TOPIC_PREFIX}/+/voltage", qos=settings.MQTT_QOS)
    else:
        logger.error("MQTT connection failed, rc=%d", rc)


def start_mqtt():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    client.username_pw_set(settings.MQTT_USERNAME, settings.MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    try:
        client.connect(settings.MQTT_HOST, settings.MQTT_PORT, keepalive=60)
        client.loop_start()
    except Exception as e:
        logger.warning("MQTT broker not available (%s), will retry in background...", e)
        client.loop_start()
        threading.Thread(target=_reconnect_loop, args=(client,), daemon=True).start()
    return client
