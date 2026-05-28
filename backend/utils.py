import re
import logging

from config import settings

logger = logging.getLogger(__name__)

# Chicken ID: 1-32 символа, только цифры, латинские буквы, дефис, подчёркивание
_CHICKEN_ID_RE = re.compile(r'^[A-Za-z0-9_\-]{1,32}$')


def get_status(temp) -> str:
    if temp is None:
        return "unknown"
    if temp < settings.TEMP_GREEN_MIN or temp > settings.TEMP_YELLOW_MAX:
        return "red"
    elif temp > settings.TEMP_GREEN_MAX:
        return "yellow"
    return "green"


def is_valid_chicken_id(chicken_id: str) -> bool:
    return bool(_CHICKEN_ID_RE.match(chicken_id))
