#!/usr/bin/env python3
"""
Эмулятор IoT-датчиков температуры кур.
Публикует данные в MQTT-брокер в формате JSON с метками времени
для измерения задержки (latency) и потерь пакетов (packet loss).

Примеры запуска:
    python emulator.py --broker localhost --sensors 10 --qos 0
    python emulator.py --broker localhost --sensors 100 --qos 1 --interval 3
    python emulator.py --broker localhost --sensors 50 --qos 2 --loss 0.05
"""

import argparse
import json
import logging
import random
import time
import urllib.request

import paho.mqtt.client as mqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def calibrate_clock(api_url: str, attempts: int = 10) -> float:
    """
    Вычисляет смещение между часами эмулятора и сервера.
    Делает несколько запросов и берёт результат с наименьшим RTT (наиболее точный).
    Возвращает offset: server_time - local_time.
    """
    best_offset = 0.0
    best_rtt = float("inf")

    # Прогрев соединения
    try:
        urllib.request.urlopen(f"{api_url}/api/qos/time", timeout=5).read()
    except Exception:
        pass
    time.sleep(0.1)

    for i in range(attempts):
        try:
            t1 = time.time()
            with urllib.request.urlopen(f"{api_url}/api/qos/time", timeout=5) as resp:
                data = json.loads(resp.read())
            t2 = time.time()
            rtt = t2 - t1
            server_time = data["server_time"]
            local_mid = (t1 + t2) / 2
            offset = server_time - local_mid

            if rtt < best_rtt:
                best_rtt = rtt
                best_offset = offset

            logger.debug("  попытка %d: offset=%.1f мс, RTT=%.1f мс", i + 1, offset * 1000, rtt * 1000)
        except Exception:
            pass
        time.sleep(0.05)

    logger.info(
        "Калибровка часов: смещение %.1f мс (лучший RTT %.1f мс из %d попыток)",
        best_offset * 1000, best_rtt * 1000, attempts,
    )
    return best_offset


class SensorEmulator:
    """Эмулирует один датчик температуры курицы."""

    def __init__(self, sensor_id: int, prefix: str, clock_offset: float = 0.0):
        self.sensor_id = str(sensor_id)
        self.prefix = prefix
        self.clock_offset = clock_offset
        self.seq_id = 0

        # Индивидуальная базовая температура для каждого датчика
        self.base_temp = random.gauss(41.0, 0.3)
        self.voltage = 3.3 + random.uniform(-0.05, 0.05)

        # Состояние "лихорадки"
        self.fever_active = False
        self.fever_until = 0.0

    def generate(self):
        """Генерирует показания датчика. Возвращает (temp_topic, temp_payload, volt_topic, volt_payload)."""
        self.seq_id += 1
        now = time.time() + self.clock_offset  # скорректированное время

        # 2% шанс начать лихорадку (30–120 секунд)
        if not self.fever_active and random.random() < 0.02:
            self.fever_active = True
            self.fever_until = time.time() + random.uniform(30, 120)

        if self.fever_active and time.time() > self.fever_until:
            self.fever_active = False

        if self.fever_active:
            temp = random.gauss(43.5, 0.5)
        else:
            temp = random.gauss(self.base_temp, 0.2)

        # Медленный разряд батареи
        self.voltage = max(2.0, self.voltage - random.uniform(0.0005, 0.002))

        temp_payload = json.dumps({
            "value": round(temp, 2),
            "sent_ts": now,
            "seq_id": self.seq_id,
        })

        volt_payload = json.dumps({
            "value": round(self.voltage, 3),
            "sent_ts": now,
            "seq_id": self.seq_id,
        })

        temp_topic = f"{self.prefix}/{self.sensor_id}/Temperature"
        volt_topic = f"{self.prefix}/{self.sensor_id}/voltage"

        return temp_topic, temp_payload, volt_topic, volt_payload


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        logger.info("Подключено к MQTT-брокеру")
    else:
        logger.error("Ошибка подключения к MQTT, rc=%d", rc)


def main():
    parser = argparse.ArgumentParser(description="Эмулятор IoT-датчиков температуры кур")
    parser.add_argument("--broker", default="localhost", help="Адрес MQTT-брокера (default: localhost)")
    parser.add_argument("--port", type=int, default=1883, help="Порт MQTT-брокера (default: 1883)")
    parser.add_argument("--username", default="", help="Имя пользователя MQTT")
    parser.add_argument("--password", default="", help="Пароль MQTT")
    parser.add_argument("--prefix", default="ThermoChicken", help="Префикс MQTT-топика (default: ThermoChicken)")
    parser.add_argument("--sensors", type=int, default=10, help="Количество датчиков (default: 10)")
    parser.add_argument("--interval", type=float, default=5.0, help="Интервал отправки в секундах (default: 5)")
    parser.add_argument("--qos", type=int, default=1, choices=[0, 1, 2], help="Уровень QoS MQTT (default: 1)")
    parser.add_argument("--loss", type=float, default=0.0, help="Вероятность потери пакета 0.0–1.0 (default: 0)")
    parser.add_argument("--api-url", default="http://localhost:8000", help="URL серверной части для калибровки часов")
    args = parser.parse_args()

    # Калибровка часов между хостом и Docker-контейнером
    clock_offset = calibrate_clock(args.api_url)

    logger.info(
        "Запуск: %d датчиков, интервал %.1fs, QoS %d, потери %.1f%%",
        args.sensors, args.interval, args.qos, args.loss * 100,
    )

    # Создаём MQTT-клиент
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    if args.username:
        client.username_pw_set(args.username, args.password)
    client.on_connect = on_connect
    client.connect(args.broker, args.port, keepalive=60)
    client.loop_start()

    # Создаём эмуляторы датчиков
    sensors = [SensorEmulator(i + 1, args.prefix, clock_offset) for i in range(args.sensors)]

    # Пауза между отправками отдельных датчиков (для равномерной нагрузки)
    stagger = args.interval / max(args.sensors, 1)

    try:
        while True:
            cycle_start = time.time()

            for sensor in sensors:
                temp_topic, temp_payload, volt_topic, volt_payload = sensor.generate()

                # Имитация потери пакета: пропускаем отправку, но seq_id растёт
                if args.loss > 0 and random.random() < args.loss:
                    continue

                client.publish(temp_topic, temp_payload, qos=args.qos)
                client.publish(volt_topic, volt_payload, qos=args.qos)

                # Равномерное распределение отправок по интервалу
                if args.sensors > 1:
                    time.sleep(stagger)

            # Дождаться окончания интервала
            elapsed = time.time() - cycle_start
            remaining = args.interval - elapsed
            if remaining > 0:
                time.sleep(remaining)

            logger.info(
                "Цикл завершён: %d датчиков, %.1f мс",
                args.sensors, (time.time() - cycle_start) * 1000,
            )

    except KeyboardInterrupt:
        logger.info("Остановка эмулятора...")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
