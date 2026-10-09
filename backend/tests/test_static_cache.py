"""Cache headers on the files the backend serves to the app window.

Regression for the "updated install still shows the old UI" bug: without an
explicit Cache-Control, Chromium reused index.html from its cache for 10% of
the file's age, so a freshly installed version kept running the previous
version's UI. See static_cache.py.
"""
import os
import time

from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.testclient import TestClient

from static_cache import IMMUTABLE, REVALIDATE, CacheControlStaticFiles, cache_control_for


def _client(tmp_path, **kwargs):
    (tmp_path / "static" / "js").mkdir(parents=True)
    (tmp_path / "index.html").write_text("<html>v1</html>")
    (tmp_path / "static" / "js" / "main.abc12345.js").write_text("console.log(1)")
    (tmp_path / "electron.js").write_text("// not hashed")
    app = Starlette(routes=[Mount("/", CacheControlStaticFiles(directory=str(tmp_path), **kwargs))])
    return TestClient(app)


def test_rule_per_path():
    assert cache_control_for("index.html", "static") == REVALIDATE
    assert cache_control_for(".", "static") == REVALIDATE
    assert cache_control_for("static/js/main.abc12345.js", "static") == IMMUTABLE
    assert cache_control_for("static\\js\\main.abc12345.js", "static") == IMMUTABLE
    # A file merely NAMED like the prefix is not inside it.
    assert cache_control_for("static.json", "static") == REVALIDATE
    # No hashed prefix (the atlas mount): nothing is immutable.
    assert cache_control_for("static/js/main.abc12345.js", None) == REVALIDATE


def test_index_html_must_be_revalidated(tmp_path):
    client = _client(tmp_path, html=True, hashed_prefix="static")
    for url in ("/", "/index.html"):
        r = client.get(url)
        assert r.status_code == 200
        assert r.headers["cache-control"] == REVALIDATE


def test_hashed_assets_are_immutable_and_other_files_are_not(tmp_path):
    client = _client(tmp_path, html=True, hashed_prefix="static")
    assert client.get("/static/js/main.abc12345.js").headers["cache-control"] == IMMUTABLE
    assert client.get("/electron.js").headers["cache-control"] == REVALIDATE


def test_revalidation_returns_304_then_the_new_file_after_an_update(tmp_path):
    """The whole point: an unchanged index.html costs a 304, and a replaced one
    (a new install) is fetched again instead of being served from cache."""
    client = _client(tmp_path, html=True, hashed_prefix="static")
    first = client.get("/index.html")
    validators = {"If-None-Match": first.headers["etag"]}

    unchanged = client.get("/index.html", headers=validators)
    assert unchanged.status_code == 304
    assert unchanged.headers["cache-control"] == REVALIDATE

    index = tmp_path / "index.html"
    index.write_text("<html>v2 - a longer page</html>")
    later = time.time() + 60
    os.utime(index, (later, later))  # a new install: different size and mtime
    updated = client.get("/index.html", headers=validators)
    assert updated.status_code == 200
    assert "v2" in updated.text


def test_atlas_style_mount_never_marks_files_immutable(tmp_path):
    client = _client(tmp_path)  # no hashed_prefix, as the /atlases mount uses it
    assert client.get("/static/js/main.abc12345.js").headers["cache-control"] == REVALIDATE
