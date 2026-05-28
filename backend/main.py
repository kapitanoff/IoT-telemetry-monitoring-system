import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import inspect, text

from database import engine, Base
import models
from routers import chickens, groups, qos
from mqtt_client import start_mqtt
from aggregator import start_aggregator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"


def _run_migrations(engine):
    """Add new tables and columns that create_all doesn't handle."""
    Base.metadata.create_all(bind=engine)
    insp = inspect(engine)
    # Add group_id column to chickens if missing
    if "chickens" in insp.get_table_names():
        columns = [c["name"] for c in insp.get_columns("chickens")]
        if "group_id" not in columns:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE chickens ADD COLUMN group_id INTEGER "
                    "REFERENCES groups(id) ON DELETE SET NULL"
                ))


@asynccontextmanager
async def lifespan(app: FastAPI):
    _run_migrations(engine)
    mqtt_client = start_mqtt()
    start_aggregator()
    yield
    mqtt_client.loop_stop()
    mqtt_client.disconnect()


# docs_url=None, redoc_url=None — отключаем Swagger UI и ReDoc в продакшене
app = FastAPI(title="Chicken Monitor", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self';"
    )
    return response


app.include_router(chickens.router, prefix="/api")
app.include_router(groups.router, prefix="/api")
app.include_router(qos.router, prefix="/api")

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))
