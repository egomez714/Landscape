from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import company as company_router
from app.routers import crawl_history as crawl_history_router
from app.routers import query as query_router
from app.services import db


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.init()
    try:
        yield
    finally:
        await db.close()


app = FastAPI(title="Landscape Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(query_router.router)
app.include_router(company_router.router)
app.include_router(crawl_history_router.router)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "hd_key_loaded": bool(settings.hd_api_key),
        "gemini_key_loaded": bool(settings.gemini_api_key),
    }
