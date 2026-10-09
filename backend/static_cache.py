"""Cache headers for the files the backend serves to the app's own window.

Why this exists: Starlette's StaticFiles sends ETag + Last-Modified but no
Cache-Control. A browser then *guesses* how long a file stays fresh — Chromium
uses 10% of the file's age when it was fetched — and reuses its cached copy for
that long without asking. The desktop app loads its UI from this backend and
keeps that browser cache across reinstalls, so after an update it kept showing
the PREVIOUS version's index.html (which names the previous version's script)
for hours to days: a new backend and main process under an old UI.

The rule here removes the guess:

  * Content-hashed build assets (CRA's /static/js|css|media/<name>.<hash>.*)
    never change under the same URL, so they are immutable.
  * Everything else — index.html above all, and atlas volumes, whose files CAN
    change under the same URL when a module is updated — is `no-cache`: the
    browser may keep a copy but must revalidate it every time. Unchanged files
    still cost only a 304.
"""
from starlette.staticfiles import StaticFiles

REVALIDATE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"


def cache_control_for(path: str, hashed_prefix: str | None) -> str:
    """Cache-Control value for a path relative to the served directory."""
    rel = path.replace("\\", "/").lstrip("/")
    if hashed_prefix and rel.startswith(hashed_prefix.strip("/") + "/"):
        return IMMUTABLE
    return REVALIDATE


class CacheControlStaticFiles(StaticFiles):
    """StaticFiles that always says how long a response may be reused.

    `hashed_prefix`: sub-folder whose file names carry a content hash (pass
    "static" for a CRA build); None means nothing served here is immutable.
    """

    def __init__(self, *args, hashed_prefix: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._hashed_prefix = hashed_prefix

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = cache_control_for(path, self._hashed_prefix)
        return response
