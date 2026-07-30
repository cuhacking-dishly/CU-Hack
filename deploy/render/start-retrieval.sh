#!/bin/sh
set -eu

OLLAMA_LOG="${DISHLY_RUNTIME_LOG_DIR:-/tmp}/dishly-ollama.log"

cleanup() {
  if [ -n "${API_PID:-}" ]; then kill "$API_PID" 2>/dev/null || true; fi
  if [ -n "${OLLAMA_PID:-}" ]; then kill "$OLLAMA_PID" 2>/dev/null || true; fi
}
trap cleanup INT TERM EXIT

mkdir -p "$OLLAMA_MODELS" "$(dirname "$DISHLY_INDEX_PATH")"

ollama serve >"$OLLAMA_LOG" 2>&1 &
OLLAMA_PID=$!

attempt=0
until curl --fail --silent http://127.0.0.1:11434/api/version >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "Ollama did not become ready." >&2
    cat "$OLLAMA_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

ollama pull "${OLLAMA_EMBEDDING_MODEL:-embeddinggemma}"
ollama pull "${OLLAMA_PARSER_MODEL:-qwen3:4b-instruct}"

python -m dishly_retrieval validate
if ! python -m dishly_retrieval status; then
  python -m dishly_retrieval build-index
fi
python -m dishly_retrieval status

python -m dishly_retrieval serve &
API_PID=$!
wait "$API_PID"
