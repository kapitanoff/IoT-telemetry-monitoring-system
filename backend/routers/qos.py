import time

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timezone, timedelta
from database import get_db
from models import QosMetric
from config import settings

router = APIRouter(tags=["qos"])


@router.get("/qos/time")
def server_time():
    """Текущее время сервера (Unix timestamp) для калибровки часов эмулятора."""
    return {"server_time": time.time()}


@router.get("/qos/summary")
def qos_summary(
    hours: int = Query(1, ge=1, le=8760),
    db: Session = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    q = db.query(
        func.avg(QosMetric.latency_ms).label("avg"),
        func.min(QosMetric.latency_ms).label("min"),
        func.max(QosMetric.latency_ms).label("max"),
        func.percentile_cont(0.95).within_group(QosMetric.latency_ms).label("p95"),
        func.count(QosMetric.id).label("total"),
    ).filter(QosMetric.recorded_at >= since).one()

    # Packet loss: per chicken, expected = max(seq_id) - min(seq_id) + 1
    per_chicken = (
        db.query(
            QosMetric.chicken_id,
            func.min(QosMetric.seq_id).label("min_seq"),
            func.max(QosMetric.seq_id).label("max_seq"),
            func.count(QosMetric.id).label("received"),
        )
        .filter(QosMetric.recorded_at >= since)
        .group_by(QosMetric.chicken_id)
        .all()
    )

    total_expected = 0
    total_received = 0
    for row in per_chicken:
        expected = row.max_seq - row.min_seq + 1
        total_expected += expected
        total_received += row.received

    loss_rate = 1 - (total_received / total_expected) if total_expected > 0 else 0.0

    return {
        "avg_latency_ms": round(q.avg, 2) if q.avg is not None else None,
        "min_latency_ms": round(q.min, 2) if q.min is not None else None,
        "max_latency_ms": round(q.max, 2) if q.max is not None else None,
        "p95_latency_ms": round(q.p95, 2) if q.p95 is not None else None,
        "total_messages": q.total,
        "packet_loss_rate": round(max(loss_rate, 0.0), 4),
        "qos_level": settings.MQTT_QOS,
    }


@router.get("/qos/history")
def qos_history(
    hours: int = Query(1, ge=1, le=8760),
    db: Session = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    if hours <= 24:
        trunc = func.date_trunc("minute", QosMetric.recorded_at)
    else:
        trunc = func.date_trunc("hour", QosMetric.recorded_at)

    results = (
        db.query(
            trunc.label("timestamp"),
            func.avg(QosMetric.latency_ms).label("avg_latency_ms"),
            func.count(QosMetric.id).label("count"),
        )
        .filter(QosMetric.recorded_at >= since)
        .group_by(trunc)
        .order_by(trunc.asc())
        .all()
    )

    return [
        {
            "timestamp": r.timestamp.isoformat(),
            "avg_latency_ms": round(r.avg_latency_ms, 2),
            "count": r.count,
        }
        for r in results
    ]


@router.get("/qos/by-chicken")
def qos_by_chicken(
    hours: int = Query(1, ge=1, le=8760),
    db: Session = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    rows = (
        db.query(
            QosMetric.chicken_id,
            func.avg(QosMetric.latency_ms).label("avg_latency_ms"),
            func.min(QosMetric.seq_id).label("min_seq"),
            func.max(QosMetric.seq_id).label("max_seq"),
            func.count(QosMetric.id).label("received"),
        )
        .filter(QosMetric.recorded_at >= since)
        .group_by(QosMetric.chicken_id)
        .order_by(QosMetric.chicken_id)
        .all()
    )

    return [
        {
            "chicken_id": r.chicken_id,
            "avg_latency_ms": round(r.avg_latency_ms, 2),
            "messages": r.received,
            "loss_rate": round(
                max(1 - r.received / (r.max_seq - r.min_seq + 1), 0.0), 4
            ) if r.max_seq > r.min_seq else 0.0,
        }
        for r in rows
    ]
