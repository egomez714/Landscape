# Landscape backend

FastAPI + async httpx + google-genai. uv-managed Python 3.12.

## Run

```bash
cd src/backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

Then `curl http://localhost:8000/health` should return:

```json
{"status": "ok", "hd_key_loaded": true, "gemini_key_loaded": true}
```

`.env` lives in this directory (`src/backend/.env`). See `/CLAUDE.md` for the full build plan.
