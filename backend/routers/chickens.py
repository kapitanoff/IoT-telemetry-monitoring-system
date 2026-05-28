from fastapi import APIRouter, Depends, Query, Path, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func, Integer, case
from sqlalchemy.sql.expression import cast
from datetime import datetime, timezone, timedelta
from database import get_db
from models import Chicken, TemperatureReading, AggregatedReading, QosMetric
from utils import get_status
from config import settings

MAX_ALL_RESULTS = 500
MAX_HISTORY_POINTS = 5000

router = APIRouter()

# Безопасная числовая сортировка: если chicken_id — только цифры, сортируем как Integer,
# иначе NULL (PostgreSQL ставит NULL в конец при ASC — нечисловые ID уходят в конец без краша).
_numeric_id = case(
    (Chicken.chicken_id.op('~')('^[0-9]+$'), cast(Chicken.chicken_id, Integer)),
    else_=None
)


class SettingsUpdate(BaseModel):
    temp_green_min: float
    temp_green_max: float
    temp_yellow_max: float


@router.get("/settings")
def get_settings():
    return {
        "temp_green_min": settings.TEMP_GREEN_MIN,
        "temp_green_max": settings.TEMP_GREEN_MAX,
        "temp_yellow_max": settings.TEMP_YELLOW_MAX,
    }


@router.put("/settings")
def update_settings(data: SettingsUpdate):
    if not (data.temp_green_min < data.temp_green_max < data.temp_yellow_max):
        raise HTTPException(status_code=422, detail="Thresholds must be in ascending order")
    settings.TEMP_GREEN_MIN = data.temp_green_min
    settings.TEMP_GREEN_MAX = data.temp_green_max
    settings.TEMP_YELLOW_MAX = data.temp_yellow_max
    return {
        "temp_green_min": settings.TEMP_GREEN_MIN,
        "temp_green_max": settings.TEMP_GREEN_MAX,
        "temp_yellow_max": settings.TEMP_YELLOW_MAX,
    }


@router.get("/chickens")
def get_all_chickens(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    group_id: int = Query(None),
    all: bool = Query(False),
    db: Session = Depends(get_db),
):
    # Сортировка: сначала красные (1), потом жёлтые (2), потом зелёные (3), потом без данных (4)
    status_priority = case(
        (Chicken.last_temperature == None, 4),
        (
            (Chicken.last_temperature < settings.TEMP_GREEN_MIN) |
            (Chicken.last_temperature > settings.TEMP_YELLOW_MAX),
            1
        ),
        (Chicken.last_temperature > settings.TEMP_GREEN_MAX, 2),
        else_=3
    )

    query = db.query(Chicken)
    if group_id is not None:
        query = query.filter(Chicken.group_id == group_id)

    total = query.count()

    query = query.order_by(status_priority, _numeric_id, Chicken.chicken_id)

    if not all:
        query = query.offset((page - 1) * per_page).limit(per_page)
    else:
        query = query.limit(MAX_ALL_RESULTS)

    chickens = query.all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "items": [
            {
                "chicken_id": c.chicken_id,
                "temperature": c.last_temperature,
                "voltage": c.voltage,
                "status": get_status(c.last_temperature),
                "last_seen": c.last_seen.isoformat() if c.last_seen else None,
                "group_id": c.group_id
            }
            for c in chickens
        ]
    }


@router.get("/chickens/{chicken_id}")
def get_chicken(
    chicken_id: str = Path(..., min_length=1, max_length=32, pattern=r'^[\w\-]+$'),
    db: Session = Depends(get_db),
):
    chicken = db.query(Chicken).filter(Chicken.chicken_id == chicken_id).first()
    if not chicken:
        raise HTTPException(status_code=404, detail="Chicken not found")
    return {
        "chicken_id": chicken.chicken_id,
        "temperature": chicken.last_temperature,
        "voltage": chicken.voltage,
        "status": get_status(chicken.last_temperature),
        "last_seen": chicken.last_seen.isoformat() if chicken.last_seen else None,
        "group_id": chicken.group_id,
    }


@router.get("/chickens/{chicken_id}/history")
def get_history(
    chicken_id: str = Path(..., min_length=1, max_length=32, pattern=r'^[\w\-]+$'),
    hours: int = Query(24, ge=1, le=8760),
    db: Session = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    # До 24 часов — каждая сырая точка
    if hours <= 24:
        readings = (
            db.query(TemperatureReading)
            .filter(
                TemperatureReading.chicken_id == chicken_id,
                TemperatureReading.recorded_at >= since
            )
            .order_by(TemperatureReading.recorded_at.asc())
            .limit(MAX_HISTORY_POINTS)
            .all()
        )
        return [
            {
                "timestamp": r.recorded_at.isoformat(),
                "temperature": round(r.temperature, 2),
                "voltage": r.voltage
            }
            for r in readings
        ]

    # До 7 дней — агрегируем сырые данные по часам (они ещё не удалены)
    if hours <= 168:
        trunc = func.date_trunc("hour", TemperatureReading.recorded_at)
        results = (
            db.query(
                trunc.label("timestamp"),
                func.avg(TemperatureReading.temperature).label("temperature"),
                func.avg(TemperatureReading.voltage).label("voltage")
            )
            .filter(
                TemperatureReading.chicken_id == chicken_id,
                TemperatureReading.recorded_at >= since
            )
            .group_by(trunc)
            .order_by(trunc.asc())
            .all()
        )
        # Дополняем из агрегированных (если сырые уже удалены для части периода)
        agg = (
            db.query(
                AggregatedReading.bucket.label("timestamp"),
                AggregatedReading.avg_temp.label("temperature"),
                AggregatedReading.avg_voltage.label("voltage"),
            )
            .filter(
                AggregatedReading.chicken_id == chicken_id,
                AggregatedReading.resolution == "hour",
                AggregatedReading.bucket >= since,
            )
            .order_by(AggregatedReading.bucket.asc())
            .all()
        )
        # Объединяем, убирая дубликаты по timestamp
        seen = set()
        combined = []
        for r in results:
            seen.add(r.timestamp)
            combined.append(r)
        for r in agg:
            if r.timestamp not in seen:
                combined.append(r)
        combined.sort(key=lambda r: r.timestamp)
        return [
            {
                "timestamp": r.timestamp.isoformat(),
                "temperature": round(r.temperature, 2),
                "voltage": round(r.voltage, 2) if r.voltage else None
            }
            for r in combined
        ]

    # Больше 7 дней — из агрегированных таблиц
    resolution = "hour" if hours <= 720 else "day"
    results = (
        db.query(
            AggregatedReading.bucket.label("timestamp"),
            AggregatedReading.avg_temp.label("temperature"),
            AggregatedReading.avg_voltage.label("voltage"),
        )
        .filter(
            AggregatedReading.chicken_id == chicken_id,
            AggregatedReading.resolution == resolution,
            AggregatedReading.bucket >= since,
        )
        .order_by(AggregatedReading.bucket.asc())
        .all()
    )
    return [
        {
            "timestamp": r.timestamp.isoformat(),
            "temperature": round(r.temperature, 2),
            "voltage": round(r.voltage, 2) if r.voltage else None
        }
        for r in results
    ]


@router.delete("/chickens/{chicken_id}")
def delete_chicken(
    chicken_id: str = Path(..., min_length=1, max_length=32, pattern=r'^[\w\-]+$'),
    db: Session = Depends(get_db),
):
    chicken = db.query(Chicken).filter(Chicken.chicken_id == chicken_id).first()
    if not chicken:
        raise HTTPException(status_code=404, detail="Chicken not found")
    # Delete related data explicitly (CASCADE may not exist on old DBs)
    db.query(TemperatureReading).filter(TemperatureReading.chicken_id == chicken_id).delete()
    db.query(QosMetric).filter(QosMetric.chicken_id == chicken_id).delete()
    db.delete(chicken)
    db.commit()
    return {"ok": True}
