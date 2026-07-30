# Raspberry Pi local deployment

This deployment keeps parsing, embeddings, corpus data, API, and UI on the Pi.
After setup and model downloads, searching does not require a hosted AI service.
Publisher links and images naturally require network access when a user opens
them; the local corpus retains their exact URLs and ingredients.

## Hardware and operating system

- 64-bit Raspberry Pi OS or another ARM64 Debian-family distribution
- Raspberry Pi 5 with 8 GB RAM recommended
- About 8 GB free storage for models, dependencies, build output, and headroom
- Active cooling recommended for sustained inference

`qwen3:4b-instruct` is roughly 2.5 GB and `embeddinggemma` roughly 0.6 GB. A 4 GB
Pi may swap heavily. The parser is configurable through `OLLAMA_PARSER_MODEL`,
but changing it should be followed by the real local contract test because
smaller instruction models may extract constraints less reliably.

## Prerequisites

Install Node.js 24+, npm, Python 3.11+ with `venv`, Ollama for Linux, curl, and
Nginx. Confirm Ollama is running:

```bash
curl --fail http://127.0.0.1:11434/api/version
uname -m   # expected: aarch64
```

## Build and validate

Clone to `/opt/dishly/CU-Hack` (or change every template path), create a dedicated
`dishly` user that owns the directory, then run:

```bash
cd /opt/dishly/CU-Hack
chmod +x scripts/setup-pi.sh
./scripts/setup-pi.sh
```

The script installs locked application dependencies, pulls both Ollama models,
validates the complete corpus, builds a digest-bound vector index, and creates
the production frontend bundle.

Before services, prove the local inference path:

```bash
cd /opt/dishly/CU-Hack/dishly-addon
.venv/bin/python -m unittest tests.test_goal_parser -v
.venv/bin/python -m dishly_retrieval status
```

## Services

Review the user, paths, and CORS origin in `deploy/pi`. Then:

```bash
sudo cp deploy/pi/dishly-retrieval.service /etc/systemd/system/
sudo cp deploy/pi/dishly-backend.service /etc/systemd/system/
sudo cp deploy/pi/nginx-dishly.conf /etc/nginx/sites-available/dishly
sudo ln -s /etc/nginx/sites-available/dishly /etc/nginx/sites-enabled/dishly
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now dishly-retrieval dishly-backend nginx
```

Inspect failures with:

```bash
systemctl status dishly-retrieval dishly-backend ollama nginx
journalctl -u dishly-retrieval -u dishly-backend -n 100 --no-pager
```

## Acceptance checks

```bash
curl --fail http://127.0.0.1:8000/ready
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1/api/health
```

Submit a real local parse through the public boundary:

```bash
curl --fail --header 'Content-Type: application/json' \
  --data '{"text":"Asian food for dinner with 50g protein and no peanuts"}' \
  http://127.0.0.1/api/parse-goal
```

The result must include Asian cuisine, main course, a 50g protein preference,
and both peanut intolerance/exclusion fields. `/ready` reports the parser model
digest and embedding/index state, making a missing model or stale index visible.

## Offline verification

Once models and dependencies are installed, disconnect the Pi from the internet,
restart the four local services, and repeat the parse and recipe-search checks.
Opening publisher pages/images will be unavailable offline, but parsing, safety
filtering, vector retrieval, card data, and saved swipes continue locally.
