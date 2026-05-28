from sqlalchemy import Column, String, Float, DateTime, Integer, ForeignKey, Index
from datetime import datetime, timezone
from database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class Group(Base):
    __tablename__ = "groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)


class Chicken(Base):
    __tablename__ = "chickens"

    chicken_id = Column(String(32), primary_key=True)
    last_temperature = Column(Float, nullable=True)
    voltage = Column(Float, nullable=True)
    last_seen = Column(DateTime, default=_utcnow)
    group_id = Column(Integer, ForeignKey("groups.id", ondelete="SET NULL"), nullable=True)


class TemperatureReading(Base):
    __tablename__ = "temperature_readings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    chicken_id = Column(String(32), ForeignKey("chickens.chicken_id", ondelete="CASCADE"), nullable=False)
    temperature = Column(Float, nullable=False)
    voltage = Column(Float, nullable=True)
    recorded_at = Column(DateTime, default=_utcnow)

    __table_args__ = (
        Index('ix_readings_chicken_time', 'chicken_id', 'recorded_at'),
    )


class AggregatedReading(Base):
    __tablename__ = "aggregated_readings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    chicken_id = Column(String(32), ForeignKey("chickens.chicken_id", ondelete="CASCADE"), nullable=False)
    resolution = Column(String(10), nullable=False)  # 'hour' или 'day'
    bucket = Column(DateTime, nullable=False)         # начало периода
    avg_temp = Column(Float, nullable=False)
    min_temp = Column(Float, nullable=False)
    max_temp = Column(Float, nullable=False)
    avg_voltage = Column(Float, nullable=True)
    count = Column(Integer, nullable=False)

    __table_args__ = (
        Index('ix_agg_chicken_res_bucket', 'chicken_id', 'resolution', 'bucket', unique=True),
    )


class QosMetric(Base):
    __tablename__ = "qos_metrics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    chicken_id = Column(String(32), ForeignKey("chickens.chicken_id", ondelete="CASCADE"), nullable=False)
    seq_id = Column(Integer, nullable=False)
    sent_ts = Column(Float, nullable=False)
    received_ts = Column(Float, nullable=False)
    latency_ms = Column(Float, nullable=False)
    qos_level = Column(Integer, nullable=False, default=0)
    recorded_at = Column(DateTime, default=_utcnow)

    __table_args__ = (
        Index('ix_qos_chicken_seq', 'chicken_id', 'seq_id'),
        Index('ix_qos_recorded', 'recorded_at'),
    )
