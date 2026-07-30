"""Environment-backed configuration with safe local defaults."""

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True, slots=True)
class Settings:
    """All operational settings required by the retrieval service."""

    data_path: Path = PROJECT_ROOT / "data" / "recipes.json"
    index_path: Path = PROJECT_ROOT / "data" / "embeddings.json"
    ollama_host: str = "http://127.0.0.1:11434"
    # ``ollama_model`` remains the internal embedding setting for backwards
    # compatibility with the first lessons. New deployments should use the
    # more explicit OLLAMA_EMBEDDING_MODEL environment variable.
    ollama_model: str = "embeddinggemma"
    ollama_parser_model: str = "qwen3:4b-instruct"
    ollama_expected_dimension: int = 768
    ollama_connect_timeout_seconds: float = 1.5
    ollama_read_timeout_seconds: float = 120.0
    ollama_parser_timeout_seconds: float = 180.0
    embedding_batch_size: int = 32
    service_host: str = "127.0.0.1"
    service_port: int = 8000
    service_token: str | None = None
    auto_build_index: bool = False

    @classmethod
    def from_environment(cls) -> "Settings":
        """Read optional environment overrides without requiring a secret file."""

        defaults = cls()
        settings = cls(
            data_path=Path(os.getenv("DISHLY_DATA_PATH", str(defaults.data_path))),
            index_path=Path(os.getenv("DISHLY_INDEX_PATH", str(defaults.index_path))),
            ollama_host=os.getenv("OLLAMA_HOST", defaults.ollama_host).rstrip("/"),
            ollama_model=os.getenv(
                "OLLAMA_EMBEDDING_MODEL",
                os.getenv("OLLAMA_MODEL", defaults.ollama_model),
            ).strip(),
            ollama_parser_model=os.getenv(
                "OLLAMA_PARSER_MODEL", defaults.ollama_parser_model
            ).strip(),
            ollama_expected_dimension=_read_int(
                "OLLAMA_EMBEDDING_DIMENSION",
                defaults.ollama_expected_dimension,
                1,
                16384,
            ),
            ollama_connect_timeout_seconds=_read_float(
                "OLLAMA_CONNECT_TIMEOUT_SECONDS",
                defaults.ollama_connect_timeout_seconds,
                0.1,
                30.0,
            ),
            ollama_read_timeout_seconds=_read_float(
                "OLLAMA_READ_TIMEOUT_SECONDS",
                defaults.ollama_read_timeout_seconds,
                1.0,
                600.0,
            ),
            ollama_parser_timeout_seconds=_read_float(
                "OLLAMA_PARSER_TIMEOUT_SECONDS",
                defaults.ollama_parser_timeout_seconds,
                5.0,
                600.0,
            ),
            embedding_batch_size=_read_int("DISHLY_EMBEDDING_BATCH_SIZE", 32, 1, 128),
            service_host=os.getenv("DISHLY_SERVICE_HOST", defaults.service_host).strip(),
            service_port=_read_int("DISHLY_SERVICE_PORT", defaults.service_port, 1, 65535),
            service_token=os.getenv("DISHLY_SERVICE_TOKEN", "").strip() or None,
            auto_build_index=_read_bool("DISHLY_AUTO_BUILD_INDEX", False),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        """Reject unsafe or incomplete operational settings immediately."""

        parsed_host = urlparse(self.ollama_host)
        if parsed_host.scheme not in {"http", "https"} or not parsed_host.netloc:
            raise ValueError("OLLAMA_HOST must be an absolute HTTP(S) URL")
        if parsed_host.username or parsed_host.password:
            raise ValueError("OLLAMA_HOST must not contain credentials")
        if not self.ollama_model:
            raise ValueError("OLLAMA_EMBEDDING_MODEL must not be blank")
        if not self.ollama_parser_model:
            raise ValueError("OLLAMA_PARSER_MODEL must not be blank")
        if not self.service_host:
            raise ValueError("DISHLY_SERVICE_HOST must not be blank")
        if self.service_token is not None and len(self.service_token) < 32:
            raise ValueError("DISHLY_SERVICE_TOKEN must contain at least 32 characters")


def _read_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _read_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = float(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _read_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")
