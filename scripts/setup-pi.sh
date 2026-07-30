#!/usr/bin/env bash
# Reproducible ARM64/Linux setup. Package-manager installation is intentionally
# separate so this script never changes the operating system behind your back.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
addon_root="$repo_root/dishly-addon"

for command in python3 node npm ollama curl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing prerequisite: $command" >&2
    exit 1
  }
done

python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
node -e 'const [major]=process.versions.node.split(".").map(Number); if (major < 24) throw new Error("Node.js 24+ required")'
curl --fail --silent --show-error http://127.0.0.1:11434/api/version >/dev/null || {
  echo "Ollama is not running. Start it with: systemctl --user start ollama" >&2
  exit 1
}

if [[ ! -x "$addon_root/.venv/bin/python" ]]; then
  python3 -m venv "$addon_root/.venv"
fi

"$addon_root/.venv/bin/python" -m pip install --requirement "$addon_root/requirements.lock"
"$addon_root/.venv/bin/python" -m pip install --no-deps --editable "$addon_root"
npm ci --prefix "$repo_root"
npm ci --prefix "$repo_root/backend"
npm ci --prefix "$repo_root/frontend"

ollama pull embeddinggemma
ollama pull qwen3:4b-instruct

(
  cd "$addon_root"
  .venv/bin/python -m dishly_retrieval validate
  .venv/bin/python -m dishly_retrieval build-index
  .venv/bin/python -m dishly_retrieval status
)
npm --prefix "$repo_root/frontend" run build

echo "Dishly Pi setup complete. See dishly-addon/docs/PI_DEPLOYMENT.md for services."
