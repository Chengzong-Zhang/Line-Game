import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, sessionmaker


BASE_DIR = Path(__file__).resolve().parent
FALLBACK_DATABASE_PATTERN = "game.recovered-{timestamp}.db"

logger = logging.getLogger("uvicorn.error")


class Base(DeclarativeBase):
    pass


def _default_database_file() -> Path:
    override = os.getenv("LINE_GAME_DB_PATH", "").strip()
    if override:
        return Path(override).expanduser()

    return Path(tempfile.gettempdir()) / "line-game" / "game.db"


DATABASE_FILE = _default_database_file()
CURRENT_DATABASE_FILE = DATABASE_FILE


def _build_engine(database_file: Path):
    database_file.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(
        f"sqlite:///{database_file}",
        connect_args={"check_same_thread": False},
    )


engine = _build_engine(DATABASE_FILE)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


def init_db() -> None:
    # Import models here so SQLAlchemy knows which tables to create.
    try:
        from .models import User  # type: ignore  # noqa: F401
    except ImportError:
        from models import User  # noqa: F401

    try:
        Base.metadata.create_all(bind=engine)
    except OperationalError as exc:
        if not _should_recover_sqlite(exc):
            raise

        recovered_file = _recover_sqlite_database()
        Base.metadata.create_all(bind=engine)
        logger.warning("Recovered SQLite database using %s", recovered_file.name)


def _should_recover_sqlite(exc: OperationalError) -> bool:
    message = str(exc).lower()
    return "disk i/o error" in message or "database disk image is malformed" in message


def _recover_sqlite_database() -> Path:
    global CURRENT_DATABASE_FILE

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_paths = _try_backup_broken_sqlite_files(timestamp)
    if backup_paths:
        return CURRENT_DATABASE_FILE

    fallback_file = CURRENT_DATABASE_FILE.with_name(
        FALLBACK_DATABASE_PATTERN.format(timestamp=timestamp)
    )
    _swap_engine(fallback_file)
    return fallback_file


def _try_backup_broken_sqlite_files(timestamp: str) -> list[Path]:
    engine.dispose()

    backup_paths: list[Path] = []
    journal_file = CURRENT_DATABASE_FILE.with_name(f"{CURRENT_DATABASE_FILE.name}-journal")
    for source in (journal_file, CURRENT_DATABASE_FILE):
        if not source.exists():
            continue

        destination = source.with_name(f"{source.name}.broken-{timestamp}")
        try:
            source.replace(destination)
        except PermissionError:
            logger.warning("Could not move aside broken SQLite file %s", source.name)
            return []
        backup_paths.append(destination)

    _swap_engine(DATABASE_FILE)
    return backup_paths


def _swap_engine(database_file: Path) -> None:
    global CURRENT_DATABASE_FILE, engine
    CURRENT_DATABASE_FILE = database_file
    engine = _build_engine(database_file)
    SessionLocal.configure(bind=engine)
