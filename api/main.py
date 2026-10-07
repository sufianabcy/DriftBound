"""The FastAPI app: /api routes, the live WebSocket, and the built dashboard at /.

One process serves everything, so the browser talks to a single address and
needs no cross-origin setup. Run exactly one uvicorn worker: live run state is
held in this process's memory.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, get_settings
from .db import Database
from .live import Hub
from .manager import RunManager
from .routes import build_router
from .storage import ModelStore

VERSION = "0.1.0"

log = logging.getLogger("driftbound")
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>DriftBound API</title>
<body style="font-family: system-ui; max-width: 40rem; margin: 3rem auto; line-height: 1.5">
<h1>DriftBound API is running</h1>
<p>The dashboard has not been built into <code>web/dist</code>. During development open the Vite
server at <a href="http://localhost:5173">localhost:5173</a>, or run <code>npm run build</code> in
<code>web/</code>.</p><p>The interactive API page is at <a href="/docs">/docs</a>.</p></body>"""


class DashboardFiles(StaticFiles):
    """The built dashboard, with cache headers that make redeploys show up at once.

    Vite puts a content hash in every asset name, so assets can be cached for a
    year. index.html is the one file whose name never changes: browsers must
    revalidate it on every load, or a phone would keep running the old build.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        hashed = Path(full_path).parent.name == "assets"
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if hashed else "no-cache"
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    db = Database(settings.database_url)
    store = ModelStore(settings.models_bucket, settings.models_dir, settings.aws_region)
    manager = RunManager(settings, db, store, Hub())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            await db.init()
            log.info("database ready (%s)", db.dialect)
        except Exception as exc:
            # The live demo works without history; /api/health reports the problem.
            db.ok = False
            db.last_error = str(exc)
            log.error("database unavailable, continuing without history: %s", exc)
        await manager.start()
        try:
            yield
        finally:
            await manager.shutdown()
            await db.close()

    app = FastAPI(
        title="DriftBound API",
        version=VERSION,
        description="Streaming drift detection and adaptation with proven label bounds.",
        lifespan=lifespan,
    )
    app.state.manager = manager
    app.include_router(build_router(manager, VERSION), prefix="/api")

    dist = Path(settings.web_dist)
    if (dist / "index.html").is_file():
        app.mount("/", DashboardFiles(directory=dist, html=True), name="dashboard")
    else:

        @app.get("/", include_in_schema=False)
        async def dashboard_not_built() -> HTMLResponse:
            return HTMLResponse(NOT_BUILT)

    return app


app = create_app()
