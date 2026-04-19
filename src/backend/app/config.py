
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    hd_api_key: str = ""
    gemini_api_key: str = ""
    hd_base_url: str = "https://api.humandelta.ai"

    # Resolved from env var CACHE_DIR; defaults to the repo-local .cache dir so
    # local dev matches the pre-Feature-1 behavior. On Railway, set CACHE_DIR=/data
    # to use a mounted volume so crawls + edges survive redeploys.
    cache_dir: Path = BACKEND_ROOT / ".cache"

    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
