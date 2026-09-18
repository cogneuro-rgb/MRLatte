"""Atlas registry HTTP surface.

Everything an atlas needs that the module installer cannot do: list what is
installed, install one from the catalog, import the user's own, reorder them,
recolour regions, split an atlas left/right, export a region as an ROI mask,
and remove one atlas without touching the others.

Why not the modules router: a `data` module is a fixed set of pre-hashed files
declared in manifest.json, and `_uninstall_guard` refuses to remove anything
absent from the install ledger. Neither fits here. A catalog atlas has no
pre-pinned sha256 (by design -- see data/modules/atlas-catalog.json), a
user-imported atlas has no manifest entry at all, and every shipped atlas must
be removable even though it arrived with the checkout. So atlases carry their
own registry, their own state file and their own containment guard, and
routers/modules.py is left exactly as it was.

Boundary: every write and delete resolves through
atlas_registry.within_atlas_dir(). Uploaded files are attacker-controlled
input, so an id is `slug()`ed and re-checked rather than trusted.
"""
import json
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import atlas_labels
import atlas_ops
import atlas_registry
import atlas_validate
import deps

router = APIRouter()

# Downloads may legitimately differ a little from the recorded size (a
# regenerated .nii.gz compresses differently), but not by a lot. Same tolerance
# idea as routers/modules._SIZE_TOLERANCE, widened because we are checking a
# third-party file we never hashed.
_SIZE_TOLERANCE = 0.25

_JOBS = {}
_JOB_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _catalog_path() -> Path:
    return Path(deps.MODULE_ROOT) / "atlas-catalog.json"


def _catalog() -> list:
    try:
        raw = json.loads(_catalog_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return list(raw.get("atlases") or [])


def _catalog_entry(catalog_id: str):
    for e in _catalog():
        if e.get("catalogId") == catalog_id:
            return e
    return None


def _staging_root() -> Path:
    d = Path(deps.MODULE_ROOT) / ".staging"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _bad(exc: atlas_registry.AtlasError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


def _sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch(url: str, dest: Path, expected_bytes=None) -> int:
    """Download `url` to `dest`. Raises RuntimeError with a user-facing reason.

    Integrity here is size + (later) NIfTI-header sanity, not a pinned digest:
    catalog URLs are pinned to an immutable commit SHA instead, and the hash of
    what actually arrived is recorded in atlases.state.json so a later verify
    can still catch local corruption.
    """
    import requests

    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=(10, 120),
                      headers={"Accept-Encoding": "identity"},
                      allow_redirects=True) as r:
        if r.status_code >= 400:
            raise RuntimeError("download failed (HTTP %d) for %s" % (r.status_code, url))
        size = 0
        with open(dest, "wb") as fh:
            for chunk in r.iter_content(1 << 16):
                if chunk:
                    fh.write(chunk)
                    size += len(chunk)
    if expected_bytes:
        lo = expected_bytes * (1 - _SIZE_TOLERANCE)
        hi = expected_bytes * (1 + _SIZE_TOLERANCE)
        if not (lo <= size <= hi):
            raise RuntimeError(
                "downloaded %d bytes but the catalog records %d — the upstream "
                "file is not what this catalog was built against."
                % (size, expected_bytes))
    return size


def _install_from_files(atlas_id, volume_src, regions, descriptor_fields):
    """Write one atlas folder from a staged volume + regions. Returns descriptor.

    The single place an atlas becomes installed, shared by the catalog
    installer, the import wizard and derive-lr -- so validation, centroid
    computation and the write order cannot drift between them.
    """
    if not atlas_registry.is_valid_id(atlas_id):
        raise atlas_registry.AtlasError(
            "'%s' is not a usable atlas id (letters, digits and underscores; "
            "not a reserved name)" % atlas_id)
    if atlas_registry.resolve(atlas_id) is not None:
        raise atlas_registry.AtlasError("an atlas called '%s' is already installed" % atlas_id)

    folder = atlas_registry.atlas_dir() / atlas_id
    if not atlas_registry.within_atlas_dir(folder.parent):
        raise atlas_registry.AtlasError("atlas directory is not writable")

    ok, reason, details = atlas_validate.inspect_volume(volume_src)
    if not ok:
        raise atlas_registry.AtlasError(reason)

    if not regions:
        regions = [{"value": int(v), "name": "Region %d" % int(v), "hemi": None,
                    "color": None, "centroidMM": None}
                   for v in details.get("labelValues") or []]

    folder.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copyfile(str(volume_src), str(folder / ("%s.nii.gz" % atlas_id)))
        vol_path = folder / ("%s.nii.gz" % atlas_id)
        atlas_ops.apply_centroids(regions, atlas_ops.region_stats(vol_path, regions))
        atlas_labels.write_labels(folder / ("%s.labels.json" % atlas_id), regions)

        descriptor = {
            "schemaVersion": 1,
            "id": atlas_id,
            "aliases": [],
            "name": atlas_id,
            "short": atlas_id,
            "description": "",
            "kind": details.get("kind") or "parcellation",
            "space": "MNI152",
            "volume": "%s.nii.gz" % atlas_id,
            "labels": "%s.labels.json" % atlas_id,
            "colormap": "random",
            "opacity": 0.55,
            "ignoreZeroVoxels": True,
            "lateralized": details.get("lateralized"),
            "origin": {"kind": "import"},
            "license": {},
        }
        descriptor.update({k: v for k, v in (descriptor_fields or {}).items()
                           if v is not None})
        descriptor["id"] = atlas_id
        atlas_registry.write_descriptor(folder, descriptor)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return atlas_registry.require(atlas_id)


# --------------------------------------------------------------------------- #
# Listing
# --------------------------------------------------------------------------- #

@router.get("/atlases")
async def list_atlases():
    """Everything the client needs to render the atlas list and the manager."""
    installed = atlas_registry.list_atlases()
    have = set()
    for d in installed:
        have.add(d["id"])
        have.update(d.get("aliases") or [])
    catalog = [dict(e, installed=e.get("atlasId") in have) for e in _catalog()]
    return {
        "schemaVersion": atlas_registry.SCHEMA_VERSION,
        "atlasDir": str(atlas_registry.atlas_dir()),
        "atlases": installed,
        "order": [d["id"] for d in installed],
        "catalog": catalog,
    }


@router.get("/atlases/catalog")
async def get_catalog():
    return {"atlases": _catalog()}


@router.get("/atlases/{atlas_id}/labels")
async def get_labels(atlas_id: str):
    d = atlas_registry.resolve(atlas_id)
    if d is None:
        raise HTTPException(status_code=404, detail="no atlas '%s'" % atlas_id)
    return {"id": d["id"], "regions": atlas_labels.read_labels_or_empty(d["labelsPath"])}


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #

class PatchAtlas(BaseModel):
    name: Optional[str] = None
    short: Optional[str] = None
    description: Optional[str] = None
    colormap: Optional[str] = None
    opacity: Optional[float] = None
    ignoreZeroVoxels: Optional[bool] = None
    kind: Optional[str] = None
    hidden: Optional[bool] = None
    # {"12": [r, g, b]} — null for one value resets it to the colormap default.
    colors: Optional[dict] = None


@router.patch("/atlases/{atlas_id}")
async def patch_atlas(atlas_id: str, body: PatchAtlas):
    try:
        if body.colors is not None:
            atlas_registry.set_region_colors(atlas_id, body.colors)
        d = atlas_registry.patch(atlas_id, body.model_dump(exclude={"colors"}))
    except atlas_registry.AtlasError as exc:
        raise _bad(exc)
    return {"ok": True, "atlas": d}


class OrderRequest(BaseModel):
    order: List[str]


@router.post("/atlases/order")
async def set_order(body: OrderRequest):
    return {"ok": True, "order": atlas_registry.set_order(body.order)}


@router.delete("/atlases/{atlas_id}")
async def delete_atlas(atlas_id: str):
    try:
        return {"ok": True, **atlas_registry.remove(atlas_id)}
    except atlas_registry.AtlasError as exc:
        raise _bad(exc)


class DeriveLRRequest(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None


@router.post("/atlases/{atlas_id}/derive-lr")
async def derive_lr(atlas_id: str, body: Optional[DeriveLRRequest] = None):
    """Split every bilateral label into a left and a right label.

    Produces a NEW atlas; the source is untouched, so an atlas that turns out
    to have been split wrongly costs nothing to discard. The volume and the
    label list are rewritten together by atlas_ops.split_lr -- they are one
    fact, and renumbering one without the other mislabels the whole brain.
    """
    try:
        src = atlas_registry.require(atlas_id)
    except atlas_registry.AtlasError as exc:
        raise _bad(exc)

    new_id = atlas_registry.slug((body.id if body else None) or "%s_lr" % src["id"])
    regions = atlas_labels.read_labels_or_empty(src["labelsPath"])

    def _work():
        img, new_regions = atlas_ops.split_lr(src["volumePath"], regions)
        stage = Path(tempfile.mkdtemp(dir=str(_staging_root()), prefix="atlas-lr-"))
        try:
            import nibabel as nib
            tmp_vol = stage / "volume.nii.gz"
            nib.save(img, str(tmp_vol))
            return _install_from_files(new_id, tmp_vol, new_regions, {
                "name": (body.name if body else None) or "%s (L/R split)" % src["name"],
                "short": "%s L/R" % src["short"],
                "description": src["description"],
                "kind": src["kind"],
                "space": src["space"],
                "colormap": src["colormap"],
                "opacity": src["opacity"],
                "lateralized": True,
                "derivedFrom": src["id"],
                "origin": {"kind": "derived", "derivedFrom": src["id"],
                           "at": time.time()},
                "license": src["license"],
            })
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    try:
        d = await run_in_threadpool(_work)
    except atlas_registry.AtlasError as exc:
        raise _bad(exc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "atlas": d}


class RegionMaskRequest(BaseModel):
    values: List[int]
    label: Optional[str] = None


@router.post("/atlases/{atlas_id}/region-mask")
async def make_region_mask(atlas_id: str, body: RegionMaskRequest):
    """Turn one or more atlas regions into a binary mask, served as .nii.gz.

    Written under the existing ROI results tree so it is downloadable and
    loadable by the viewer through the same route as /api/roi/sphere output.
    """
    try:
        d = atlas_registry.require(atlas_id)
    except atlas_registry.AtlasError as exc:
        raise _bad(exc)

    names = atlas_labels.name_map(atlas_labels.read_labels_or_empty(d["labelsPath"]))
    chosen = [v for v in body.values if v in names] or list(body.values)
    if not chosen:
        raise HTTPException(status_code=400, detail="no regions selected")

    def _work():
        import nibabel as nib
        img = atlas_ops.region_mask(d["volumePath"], chosen)
        result_id = str(uuid.uuid4())
        out_dir = Path(deps.ROI_RESULTS_DIR) / result_id
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = atlas_registry.slug(
            body.label or (names.get(chosen[0], "region") if len(chosen) == 1
                           else "%s_%d_regions" % (d["id"], len(chosen))))
        fname = "%s.nii.gz" % (stem or "region")
        nib.save(img, str(out_dir / fname))
        return result_id, fname

    try:
        result_id, fname = await run_in_threadpool(_work)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "ok": True,
        "result_id": result_id,
        "filename": fname,
        "url": "/api/roi/result/%s/%s" % (result_id, fname),
        "regions": [{"value": v, "name": names.get(v, "region %d" % v)} for v in chosen],
    }


# --------------------------------------------------------------------------- #
# Catalog install (background job)
# --------------------------------------------------------------------------- #

def _set_job(job_id, **fields):
    with _JOB_LOCK:
        job = _JOBS.setdefault(job_id, {"job_id": job_id})
        job.update(fields)
        job["updatedAt"] = time.time()
        return dict(job)


def _run_catalog_install(job_id: str, entry: dict):
    stage = Path(tempfile.mkdtemp(dir=str(_staging_root()), prefix="atlas-dl-"))
    try:
        _set_job(job_id, stage="downloading", progress=0.05)
        vol = stage / "volume.nii.gz"
        _fetch(entry["volume"]["url"], vol, entry["volume"].get("bytes"))

        _set_job(job_id, stage="labels", progress=0.55)
        regions = []
        for key in ("labels", "metadata"):
            spec = entry.get(key)
            if not spec:
                continue
            side = stage / ("labels_%s" % key)
            try:
                _fetch(spec["url"], side, spec.get("bytes"))
                regions = atlas_labels.read_labels(side)
                break
            except (RuntimeError, OSError, atlas_labels.LabelParseError):
                continue

        _set_job(job_id, stage="installing", progress=0.75)
        d = _install_from_files(entry["atlasId"], vol, regions, {
            "name": entry.get("name"),
            "short": entry.get("short"),
            "description": entry.get("description"),
            "kind": entry.get("kind"),
            "space": entry.get("space"),
            "license": entry.get("license"),
            "origin": {"kind": "catalog", "catalogId": entry.get("catalogId"),
                       "url": entry["volume"]["url"], "at": time.time()},
        })
        # No pre-pinned digest to compare against, so record what arrived.
        atlas_registry.record_checksums(d["id"], {
            d["volume"]: _sha256(Path(d["volumePath"])),
        })
        _set_job(job_id, stage="done", progress=1.0, done=True, atlas=d)
    except atlas_registry.AtlasError as exc:
        _set_job(job_id, stage="error", done=True, error=str(exc))
    except Exception as exc:  # noqa: BLE001 — a job reports, it does not crash
        _set_job(job_id, stage="error", done=True, error=str(exc))
    finally:
        shutil.rmtree(stage, ignore_errors=True)


@router.post("/atlases/catalog/{catalog_id}/install")
async def install_from_catalog(catalog_id: str):
    entry = _catalog_entry(catalog_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="no catalog atlas '%s'" % catalog_id)
    if atlas_registry.resolve(entry["atlasId"]) is not None:
        raise HTTPException(status_code=409,
                            detail="'%s' is already installed" % entry["atlasId"])
    job_id = str(uuid.uuid4())
    _set_job(job_id, catalogId=catalog_id, stage="queued", progress=0.0,
             done=False, error=None, bytes_total=entry.get("bytes") or 0,
             startedAt=time.time())
    threading.Thread(target=_run_catalog_install, args=(job_id, entry),
                     name="atlas-install-%s" % catalog_id, daemon=True).start()
    return {"job_id": job_id, "catalogId": catalog_id}


@router.get("/atlases/jobs/{job_id}")
async def atlas_job_status(job_id: str):
    with _JOB_LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job")
    return dict(job)


# --------------------------------------------------------------------------- #
# Import wizard: stage -> review -> commit
# --------------------------------------------------------------------------- #

_STAGES = {}


def _stage_dir(stage_id: str) -> Path:
    d = _STAGES.get(stage_id)
    if d is None or not Path(d).is_dir():
        raise HTTPException(status_code=404, detail="that upload has expired; start again")
    return Path(d)


@router.post("/atlases/import/stage")
async def stage_import(
    volume: UploadFile = File(...),
    labels: Optional[UploadFile] = File(None),
    name: str = Form(""),
):
    """Inspect an uploaded atlas and report what we found, without installing.

    Nothing is written into ATLAS_DIR here. The client shows the report, lets
    the user fix the name, the id and the region names, and decide on a left/
    right split; only then does /commit write anything.
    """
    filename = (volume.filename or "atlas.nii.gz")
    lower = filename.lower()
    if not (lower.endswith(".nii") or lower.endswith(".nii.gz")):
        raise HTTPException(status_code=400,
                            detail="the atlas volume must be .nii or .nii.gz")

    stage = Path(tempfile.mkdtemp(dir=str(_staging_root()), prefix="atlas-import-"))
    stage_id = str(uuid.uuid4())
    try:
        vol_path = deps.save_upload_nifti(volume, stage, stem="volume")

        regions, label_error = [], None
        if labels is not None:
            raw = await labels.read()
            try:
                regions = atlas_labels.parse_labels(raw, hint=labels.filename or "")
            except atlas_labels.LabelParseError as exc:
                label_error = str(exc)

        ok, reason, details = await run_in_threadpool(atlas_validate.inspect_volume, vol_path)
        if not ok:
            shutil.rmtree(stage, ignore_errors=True)
            raise HTTPException(status_code=400, detail=reason)

        warnings = list(details.get("warnings") or [])
        if label_error:
            warnings.append("label file: %s" % label_error)
        if not regions:
            warnings.append(
                "no label list was supplied, so regions are named 'Region N'. "
                "Upload a label file (JSON, CSV, FreeSurfer/FSL LUT, FSL XML or "
                "one name per line) to get real names, or rename them below.")
            regions = [{"value": int(v), "name": "Region %d" % int(v),
                        "hemi": None, "color": None, "centroidMM": None}
                       for v in details.get("labelValues") or []]
        else:
            warnings.extend(atlas_validate.cross_check_labels(details, regions))

        base = name or Path(filename).name
        for ext in (".nii.gz", ".nii"):
            if base.lower().endswith(ext):
                base = base[: -len(ext)]
                break
        suggested = atlas_registry.slug(base) or "atlas"
        if atlas_registry.resolve(suggested) is not None:
            suggested = "%s_2" % suggested

        _STAGES[stage_id] = str(stage)
        return {
            "stageId": stage_id,
            "suggestedId": suggested,
            "suggestedName": base,
            "report": {
                "shape": details.get("shape"),
                "voxelSizeMM": details.get("voxelSizeMM"),
                "kind": details.get("kind"),
                "labelCount": details.get("labelCount"),
                "lateralized": details.get("lateralized"),
                "bilateralValues": details.get("bilateralValues") or [],
                "canSplitLR": bool(details.get("bilateralValues")),
                "warnings": warnings,
            },
            "regions": regions,
        }
    except HTTPException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(stage, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc))


class CommitImport(BaseModel):
    id: str
    name: Optional[str] = None
    short: Optional[str] = None
    description: Optional[str] = None
    colormap: Optional[str] = None
    kind: Optional[str] = None
    splitLR: bool = False
    regions: Optional[List[dict]] = None
    attribution: Optional[str] = None


@router.post("/atlases/import/{stage_id}/commit")
async def commit_import(stage_id: str, body: CommitImport):
    stage = _stage_dir(stage_id)
    vol_path = next(iter(sorted(stage.glob("volume.nii*"))), None)
    if vol_path is None:
        raise HTTPException(status_code=404, detail="that upload has expired; start again")

    atlas_id = atlas_registry.slug(body.id)
    regions = [
        {"value": int(r["value"]), "name": str(r.get("name") or "Region %s" % r["value"]),
         "hemi": r.get("hemi"), "color": r.get("color"), "centroidMM": None}
        for r in (body.regions or []) if r.get("value") is not None
    ]

    def _work():
        vol, regs = vol_path, regions
        if body.splitLR:
            import nibabel as nib
            img, regs = atlas_ops.split_lr(vol_path, regions)
            vol = stage / "split.nii.gz"
            nib.save(img, str(vol))
        return _install_from_files(atlas_id, vol, regs, {
            "name": body.name or atlas_id,
            "short": body.short or body.name or atlas_id,
            "description": body.description or "",
            "kind": body.kind,
            "colormap": body.colormap or "random",
            "lateralized": True if body.splitLR else None,
            "origin": {"kind": "import", "at": time.time()},
            "license": ({"spdx": "NOASSERTION", "attribution": body.attribution}
                        if body.attribution else {}),
        })

    try:
        d = await run_in_threadpool(_work)
    except atlas_registry.AtlasError as exc:
        raise _bad(exc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        _STAGES.pop(stage_id, None)
        shutil.rmtree(stage, ignore_errors=True)
    return {"ok": True, "atlas": d}


@router.delete("/atlases/import/{stage_id}")
async def discard_import(stage_id: str):
    path = _STAGES.pop(stage_id, None)
    if path:
        shutil.rmtree(path, ignore_errors=True)
    return {"ok": True}
