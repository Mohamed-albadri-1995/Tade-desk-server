"""Async SQLAlchemy engine/session setup (SQLite via aiosqlite by default)."""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(settings.database_url, echo=False)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session():
    async with async_session_factory() as session:
        yield session


# Columns added after the initial release; create_all does not alter existing
# tables, so add them explicitly for databases created before the change.
_MIGRATION_COLUMNS = {
    "journal": [
        ("r_multiple", "FLOAT"),
        ("planned_rr", "FLOAT"),
        ("mae_pct", "FLOAT"),
        ("mfe_pct", "FLOAT"),
        ("capture_pct", "FLOAT"),
        ("hold_minutes", "FLOAT"),
        ("exit_verdict", "VARCHAR(20)"),
    ],
}


def _migrate(conn) -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(conn)
    for table, columns in _MIGRATION_COLUMNS.items():
        if table not in inspector.get_table_names():
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        for name, ddl_type in columns:
            if name not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl_type}"))


async def init_db() -> None:
    import app.models  # noqa: F401  ensure models are registered

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_migrate)
