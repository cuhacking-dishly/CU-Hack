FROM ollama/ollama:0.32.3 AS ollama

FROM python:3.12.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OLLAMA_HOST=http://127.0.0.1:11434 \
    OLLAMA_MODELS=/var/lib/dishly/ollama \
    DISHLY_DATA_PATH=/app/data/recipes.json \
    DISHLY_INDEX_PATH=/var/lib/dishly/embeddings.json \
    DISHLY_SERVICE_HOST=0.0.0.0 \
    DISHLY_SERVICE_PORT=8000

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Ollama resolves CPU/GPU runners relative to its executable. Keep the
# distribution's Linux layout intact instead of copying only the Go launcher.
COPY --from=ollama /bin/ollama /usr/bin/ollama
COPY --from=ollama /usr/lib/ollama /usr/lib/ollama

WORKDIR /app
COPY dishly-addon/requirements.lock dishly-addon/pyproject.toml ./
COPY dishly-addon/dishly_retrieval ./dishly_retrieval
COPY dishly-addon/data ./data
COPY deploy/render/start-retrieval.sh /usr/local/bin/start-dishly-retrieval

RUN python -m pip install --no-cache-dir --requirement requirements.lock \
    && python -m pip install --no-cache-dir --no-deps --editable . \
    && chmod 0755 /usr/local/bin/start-dishly-retrieval \
    && mkdir -p /var/lib/dishly/ollama

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8000/health >/dev/null || exit 1

CMD ["/usr/local/bin/start-dishly-retrieval"]
