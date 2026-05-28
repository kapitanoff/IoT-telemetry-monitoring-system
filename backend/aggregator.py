"""
Фоновая задача агрегации и очистки старых данных.

Стратегия хранения:
  0–7 дней    → сырые записи (temperature_readings)
  7–30 дней   → почасовые средние (aggregated_readings, resolution='hour')
  30–365 дней → дневные средние (aggregated_readings, resolution='day')
  > 365 дней  → удаляются

QoS-метрики хранятся 24 часа.
"""

import logging
import threading
import time
from datetime import datetime, timezone, timedelta

from sqlalchemy import func, and_
from database import SessionLocal
from models import TemperatureReading, AggregatedReading, QosMetric

logger = logging.getLogger(__name__)

# Настройки хранения
RAW_KEEP_DAYS = 7
HOURLY_KEEP_DAYS = 30
DAILY_KEEP_DAYS = 365
QOS_KEEP_HOURS = 24
RUN_INTERVAL = 3600  # раз в час


def _aggregate_raw_to_hourly(db):
    """Агрегировать сырые записи старше RAW_KEEP_DAYS в почасовые средние."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=RAW_KEEP_DAYS)
    trunc = func.date_trunc("hour", TemperatureReading.recorded_at)

    rows = (
        db.query(
            TemperatureReading.chicken_id,
            trunc.label("bucket"),
            func.avg(TemperatureReading.temperature).label("avg_temp"),
            func.min(TemperatureReading.temperature).label("min_temp"),
            func.max(TemperatureReading.temperature).label("max_temp"),
            func.avg(TemperatureReading.voltage).label("avg_voltage"),
            func.count().label("cnt"),
        )
        .filter(TemperatureReading.recorded_at < cutoff)
        .group_by(TemperatureReading.chicken_id, trunc)
        .all()
    )

    inserted = 0
    for r in rows:
        exists = (
            db.query(AggregatedReading)
            .filter_by(chicken_id=r.chicken_id, resolution="hour", bucket=r.bucket)
            .first()
        )
        if not exists:
            db.add(AggregatedReading(
                chicken_id=r.chicken_id,
                resolution="hour",
                bucket=r.bucket,
                avg_temp=round(r.avg_temp, 2),
                min_temp=round(r.min_temp, 2),
                max_temp=round(r.max_temp, 2),
                avg_voltage=round(r.avg_voltage, 2) if r.avg_voltage else None,
                count=r.cnt,
            ))
            inserted += 1

    deleted = (
        db.query(TemperatureReading)
        .filter(TemperatureReading.recorded_at < cutoff)
        .delete()
    )
    db.commit()
    if inserted or deleted:
        logger.info("Hourly aggregation: %d new buckets, %d raw rows deleted", inserted, deleted)


def _aggregate_hourly_to_daily(db):
    """Агрегировать почасовые записи старше HOURLY_KEEP_DAYS в дневные средние."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=HOURLY_KEEP_DAYS)
    trunc = func.date_trunc("day", AggregatedReading.bucket)

    rows = (
        db.query(
            AggregatedReading.chicken_id,
            trunc.label("bucket"),
            func.avg(AggregatedReading.avg_temp).label("avg_temp"),
            func.min(AggregatedReading.min_temp).label("min_temp"),
            func.max(AggregatedReading.max_temp).label("max_temp"),
            func.avg(AggregatedReading.avg_voltage).label("avg_voltage"),
            func.sum(AggregatedReading.count).label("cnt"),
        )
        .filter(
            AggregatedReading.resolution == "hour",
            AggregatedReading.bucket < cutoff,
        )
        .group_by(AggregatedReading.chicken_id, trunc)
        .all()
    )

    inserted = 0
    for r in rows:
        exists = (
            db.query(AggregatedReading)
            .filter_by(chicken_id=r.chicken_id, resolution="day", bucket=r.bucket)
            .first()
        )
        if not exists:
            db.add(AggregatedReading(
                chicken_id=r.chicken_id,
                resolution="day",
                bucket=r.bucket,
                avg_temp=round(r.avg_temp, 2),
                min_temp=round(r.min_temp, 2),
                max_temp=round(r.max_temp, 2),
                avg_voltage=round(r.avg_voltage, 2) if r.avg_voltage else None,
                count=r.cnt,
            ))
            inserted += 1

    deleted = (
        db.query(AggregatedReading)
        .filter(
            AggregatedReading.resolution == "hour",
            AggregatedReading.bucket < cutoff,
        )
        .delete()
    )
    db.commit()
    if inserted or deleted:
        logger.info("Daily aggregation: %d new buckets, %d hourly rows deleted", inserted, deleted)


def _cleanup_old_daily(db):
    """Удалить дневные агрегаты старше DAILY_KEEP_DAYS."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=DAILY_KEEP_DAYS)
    deleted = (
        db.query(AggregatedReading)
        .filter(
            AggregatedReading.resolution == "day",
            AggregatedReading.bucket < cutoff,
        )
        .delete()
    )
    if deleted:
        db.commit()
        logger.info("Deleted %d daily aggregates older than %d days", deleted, DAILY_KEEP_DAYS)


def _cleanup_qos(db):
    """Удалить QoS-метрики старше QOS_KEEP_HOURS."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=QOS_KEEP_HOURS)
    deleted = db.query(QosMetric).filter(QosMetric.recorded_at < cutoff).delete()
    if deleted:
        db.commit()
        logger.info("Deleted %d old QoS metrics", deleted)


def _run_cycle():
    db = SessionLocal()
    try:
        _aggregate_raw_to_hourly(db)
        _aggregate_hourly_to_daily(db)
        _cleanup_old_daily(db)
        _cleanup_qos(db)
    except Exception as e:
        db.rollback()
        logger.exception("Aggregation error: %s", e)
    finally:
        db.close()


def _loop():
    while True:
        _run_cycle()
        time.sleep(RUN_INTERVAL)


def start_aggregator():
    """Запускает фоновый поток агрегации."""
    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    logger.info(
        "Aggregator started (raw=%dd, hourly=%dd, daily=%dd, qos=%dh)",
        RAW_KEEP_DAYS, HOURLY_KEEP_DAYS, DAILY_KEEP_DAYS, QOS_KEEP_HOURS,
    )
