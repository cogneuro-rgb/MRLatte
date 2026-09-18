#!/usr/bin/env python3
"""
Batch lesion retinotopy export via the live MRLatte web app (Playwright).

Drives the real app so export.png is pixel-for-pixel identical to clicking
"Export PNG" in the browser. Also logs all overlap data to CSV/JSON.

Workflow per lesion (mirrors the manual UI steps):
  1. Fresh page load
  2. Open Lesion Masks section → upload .nii.gz
  3. Open Retinotopy section → enable Polar Angle + Eccentricity layers
  4. Open "Lesions for overlap" picker → check the uploaded lesion
  5. Wait for polar-summary to appear → read polar + eccen text
  6. Click Export PNG → save download

Usage:
    # Make sure the app is running first:
    #   cd frontend && yarn start   (in a separate terminal)

    python tools/scripts/batch_lesion_playwright_export.py \\
        --lesions-dir Lesion_Resliced_MNI_108_patients \\
        --output-dir output_pw \\
        [--app-url http://localhost:3000] \\
        [--headless]

Output per lesion:
    <output-dir>/<lesion_name>/export.png   — from the real app
    <output-dir>/<lesion_name>/overlap.json — polar+eccen summaries and bin data

Output aggregate:
    <output-dir>/overlap_data.csv            — long format: lesion,atlas,bin,presence
    <output-dir>/heatmap_polar_matrix.csv    — wide: lesions x polar bins (1-360)
    <output-dir>/heatmap_eccen_matrix.csv    — wide: lesions x eccen bins (0-90)
    <output-dir>/summary.csv                 — one row per lesion: name, hemifield, summaries

Requirements:
    pip install playwright
    playwright install chromium
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)


APP_URL = "http://localhost:3000"

# How long to wait (ms) for the polar summary text to appear after selecting lesion.
SUMMARY_TIMEOUT = 45_000
# How long to wait for the export PNG download to start.
DOWNLOAD_TIMEOUT = 15_000
# How long to wait for atlas layers to load after toggling them on (ms).
ATLAS_LOAD_WAIT = 3_000


def parse_summary_to_ranges(summary_text: str) -> list:
    """
    Parse 'affects 42°–44°, 46°–85°, 87°–360° · left hemifield' into
    [[42,44],[46,85],[87,360]] (inclusive pairs).
    Returns [] when 'no overlap' or text is empty.
    """
    if not summary_text or "no overlap" in summary_text.lower():
        return []
    # Strip hemifield tail
    text = re.sub(r"·.*$", "", summary_text).strip()
    text = text.replace("affects", "").strip()
    ranges = []
    for part in text.split(","):
        part = part.strip().replace("°", "")
        if "–" in part or "-" in part:
            sep = "–" if "–" in part else "-"
            lo, hi = part.split(sep, 1)
            try:
                ranges.append([int(lo.strip()), int(hi.strip())])
            except ValueError:
                pass
        else:
            try:
                v = int(part)
                ranges.append([v, v])
            except ValueError:
                pass
    return ranges


def ranges_to_bin_counts(ranges: list, min_bin=1, max_bin=360) -> dict:
    """
    Expand parsed ranges into a {bin: 1} presence dict.
    """
    counts = {}
    for s, e in ranges:
        for b in range(s, e + 1):
            if min_bin <= b <= max_bin:
                counts[b] = 1
    return counts


def extract_hemifield(summary_text: str) -> str:
    """Extract 'right', 'left', 'bilateral', or 'none' from summary text."""
    if not summary_text or "no overlap" in summary_text.lower():
        return "none"
    t = summary_text.lower()
    if "bilateral" in t:
        return "bilateral"
    if "right hemifield" in t:
        return "right"
    if "left hemifield" in t:
        return "left"
    return "unknown"


def process_lesion(page, lesion_path: Path, output_dir: Path, app_url: str) -> dict | None:
    """
    Load one lesion into MRLatte, wait for retinotopy analysis, export PNG.
    Returns the data record dict, or None on failure.

    Exact UI flow:
      1. Fresh page load
      2. Lesion Masks section → upload file
      3. Retinotopy section → toggle on polar angle + eccentricity layers
      4. Open "Lesions for overlap" picker → click the lesion checkbox
      5. Wait for polar-summary → read text
      6. Export PNG
    """
    lesion_name = lesion_path.stem
    # Strip .nii suffix if the stem still has it (e.g. foo.nii.gz → stem=foo.nii)
    if lesion_name.endswith(".nii"):
        lesion_name = lesion_name[:-4]
    out_subdir = output_dir / lesion_name
    out_subdir.mkdir(parents=True, exist_ok=True)
    export_png = out_subdir / "export.png"

    try:
        # ── 1. Fresh page load ───────────────────────────────────────────────
        page.goto(app_url, wait_until="networkidle", timeout=30_000)

        # ── 2. Open Lesion Masks section and upload ──────────────────────────
        page.locator('[data-testid="section-lesion-toggle"]').click()
        page.wait_for_timeout(300)

        file_input = page.locator('[data-testid="upload-lesion-button"]')
        file_input.set_input_files(str(lesion_path))
        # Give NiiVue time to parse and register the volume
        page.wait_for_timeout(2_000)

        # ── 3. Open Retinotopy section and enable layers ─────────────────────
        page.locator('[data-testid="section-retinotopy-toggle"]').click()
        page.wait_for_timeout(300)

        # Toggle on Polar Angle (benson_polar_angle) — starts OFF on fresh load
        page.locator('[data-testid="toggle-benson_polar_angle"]').click()
        page.wait_for_timeout(200)

        # Toggle on Eccentricity (benson_eccentricity) — starts OFF on fresh load
        page.locator('[data-testid="toggle-benson_eccentricity"]').click()

        # Wait for atlas volumes to finish loading
        page.wait_for_timeout(ATLAS_LOAD_WAIT)

        # ── 4. Open lesion picker and select our lesion ───────────────────────
        picker_toggle = page.locator('[data-testid="retinotopy-lesion-picker-toggle"]')
        picker_toggle.wait_for(state="visible", timeout=10_000)
        picker_toggle.click()
        page.wait_for_timeout(300)

        # Click the first (only) lesion option — its testid is dynamic
        # (retinotopy-lesion-opt-lesion-{timestamp}), so match by prefix.
        lesion_opt = page.locator('[data-testid^="retinotopy-lesion-opt-"]').first
        lesion_opt.wait_for(state="visible", timeout=5_000)
        lesion_opt.click()
        page.wait_for_timeout(300)

        # ── 5. Wait for polar summary text to appear ──────────────────────────
        # The summary div only renders when summaryText is non-empty,
        # so wait_for(state="visible") signals the analysis completed.
        polar_summary_loc = page.locator('[data-testid="polar-summary"]').first
        polar_summary_loc.wait_for(state="visible", timeout=SUMMARY_TIMEOUT)

        # Give React one tick for eccen summary to settle
        page.wait_for_timeout(500)

        polar_summary = polar_summary_loc.inner_text().strip()
        eccen_summary = ""
        eccen_loc = page.locator('[data-testid="eccen-summary"]').first
        try:
            eccen_loc.wait_for(state="visible", timeout=5_000)
            eccen_summary = eccen_loc.inner_text().strip()
        except Exception:
            pass

        hemifield = extract_hemifield(polar_summary)

        # ── 6. Export PNG ──────────────────────────────────────────────────────
        export_btn = page.locator('[data-testid="polar-export-btn"]').first
        with page.expect_download(timeout=DOWNLOAD_TIMEOUT) as dl_info:
            export_btn.click()

        download = dl_info.value
        download.save_as(str(export_png))

        # ── Build data record ──────────────────────────────────────────────────
        polar_ranges = parse_summary_to_ranges(polar_summary)
        eccen_ranges = parse_summary_to_ranges(eccen_summary)
        polar_bins = ranges_to_bin_counts(polar_ranges, 1, 360)
        eccen_bins = ranges_to_bin_counts(eccen_ranges, 0, 90)

        record = {
            "lesion": lesion_name,
            "polar_summary": polar_summary,
            "eccen_summary": eccen_summary,
            "hemifield": hemifield,
            "polar": {
                "arc_segments": polar_ranges,
                "bins_affected": len(polar_bins),
                "counts": {str(k): int(v) for k, v in sorted(polar_bins.items())},
            },
            "eccen": {
                "arc_segments": eccen_ranges,
                "bins_affected": len(eccen_bins),
                "counts": {str(k): int(v) for k, v in sorted(eccen_bins.items())},
            },
        }
        with open(out_subdir / "overlap.json", "w") as f:
            json.dump(record, f, indent=2)

        return record

    except PlaywrightTimeout as e:
        print(f"  TIMEOUT: {e}")
        # Save a screenshot to help debug
        try:
            page.screenshot(path=str(out_subdir / "error_screenshot.png"))
            print(f"  Screenshot saved: {out_subdir / 'error_screenshot.png'}")
        except Exception:
            pass
        return None
    except Exception as e:
        print(f"  ERROR: {e}")
        try:
            page.screenshot(path=str(out_subdir / "error_screenshot.png"))
        except Exception:
            pass
        return None


def write_aggregate_csvs(records: list, output_dir: Path):
    """Write long-format overlap CSV + wide polar/eccen matrix CSVs + summary CSV."""

    # ── Summary CSV (one row per lesion) ──────────────────────────────────────
    summary_path = output_dir / "summary.csv"
    with open(summary_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion", "hemifield", "polar_bins_affected",
                    "eccen_bins_affected", "polar_summary", "eccen_summary"])
        for r in records:
            w.writerow([
                r["lesion"], r["hemifield"],
                r["polar"]["bins_affected"], r["eccen"]["bins_affected"],
                r["polar_summary"], r["eccen_summary"],
            ])
    print(f"  -> {summary_path}")

    # ── Long-format CSV (lesion, atlas, bin_degree, presence) ────────────────
    long_path = output_dir / "overlap_data.csv"
    with open(long_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion", "atlas", "bin_degree", "presence"])
        for r in records:
            for b, v in r["polar"]["counts"].items():
                w.writerow([r["lesion"], "polar", b, v])
            for b, v in r["eccen"]["counts"].items():
                w.writerow([r["lesion"], "eccen", b, v])
    print(f"  -> {long_path}")

    # ── Wide polar matrix (lesions × bins 1..360) ─────────────────────────────
    polar_mat_path = output_dir / "heatmap_polar_matrix.csv"
    bins_p = list(range(1, 361))
    with open(polar_mat_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion"] + [str(b) for b in bins_p])
        for r in records:
            counts = r["polar"]["counts"]
            w.writerow([r["lesion"]] + [counts.get(str(b), 0) for b in bins_p])
    print(f"  -> {polar_mat_path}")

    # ── Wide eccen matrix (lesions × bins 0..90) ──────────────────────────────
    eccen_mat_path = output_dir / "heatmap_eccen_matrix.csv"
    bins_e = list(range(0, 91))
    with open(eccen_mat_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion"] + [str(b) for b in bins_e])
        for r in records:
            counts = r["eccen"]["counts"]
            w.writerow([r["lesion"]] + [counts.get(str(b), 0) for b in bins_e])
    print(f"  -> {eccen_mat_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lesions-dir", required=True,
                        help="Folder containing lesion NIfTI files (.nii / .nii.gz)")
    parser.add_argument("--output-dir", default="output_pw",
                        help="Output directory (default: output_pw)")
    parser.add_argument("--app-url", default=APP_URL,
                        help=f"MRLatte app URL (default: {APP_URL})")
    parser.add_argument("--headless", action="store_true",
                        help="Run browser in headless mode (no visible window)")
    args = parser.parse_args()

    lesions_dir = Path(args.lesions_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Gather lesion files
    lesion_files = sorted(lesions_dir.glob("*.nii.gz")) + sorted(lesions_dir.glob("*.nii"))
    if not lesion_files:
        print(f"No lesion files found in {lesions_dir}")
        sys.exit(1)
    print(f"Found {len(lesion_files)} lesion files")
    print(f"App URL : {args.app_url}")
    print(f"Output  : {output_dir}")
    print(f"Headless: {args.headless}")
    print()

    records = []
    failed = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=args.headless)
        ctx = browser.new_context(
            accept_downloads=True,
            viewport={"width": 1600, "height": 900},
        )
        page = ctx.new_page()

        for idx, lf in enumerate(lesion_files, 1):
            # Derive lesion name (strip .nii.gz or .nii)
            name = lf.stem
            if name.endswith(".nii"):
                name = name[:-4]
            print(f"[{idx:3d}/{len(lesion_files)}] {name}")

            # Resume: skip if already exported
            done_marker = output_dir / name / "export.png"
            if done_marker.exists():
                jf = output_dir / name / "overlap.json"
                if jf.exists():
                    with open(jf) as f:
                        records.append(json.load(f))
                    print("  (already done, skipping)")
                    continue

            record = process_lesion(page, lf, output_dir, args.app_url)
            if record:
                records.append(record)
                print(f"  Hemifield : {record['hemifield']}")
                print(f"  Polar     : {record['polar_summary']}")
                print(f"  Eccen     : {record['eccen_summary']}")
                print(f"  -> {done_marker}")
            else:
                failed.append(name)
                print(f"  FAILED — skipped")

        browser.close()

    # ── Write aggregate data files ───────────────────────────────────────────
    print()
    print("=" * 60)
    print("Writing aggregate data files...")
    if records:
        write_aggregate_csvs(records, output_dir)
    else:
        print("No successful records to write.")

    # ── Final report ──────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print(f"Done.  Succeeded: {len(records)}/{len(lesion_files)}")
    if failed:
        print(f"Failed ({len(failed)}):")
        for n in failed:
            print(f"  {n}")
    print(f"Outputs: {output_dir}")


if __name__ == "__main__":
    main()
