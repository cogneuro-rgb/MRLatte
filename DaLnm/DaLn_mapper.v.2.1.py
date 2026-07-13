#!/usr/bin/env python3
"""
lnm_backend.py  --  runtime (v1.7)

Degree-Adjusted Lesion Network Mapping (DA-LNM) from the compact HCP-PTN bundle
built by prepare_connectome.py.

Outputs (auto-named, in one folder): the degree-adjusted map (raw + thresholded),
POSITIVE/NEGATIVE binary masks taken AFTER the specificity test (voxels that both
pass threshold and survive the randomized-lesion null), the specificity network and
score, and a professional self-contained HTML report with a light, scrollable
multi-slice mosaic of the specificity-filtered network.

Thresholding metric:
  t  (default) : one-sample t-map; threshold |t| >= 7 (field standard for N~1000,
                 ~FWE P<1e-6). Runs hot because of the large N and the low-rank
                 variance estimate -> rely on the specificity filter.
  z            : group-average Fisher-z connectivity (effect size); threshold
                 |z| >= 0.2. An interpretable, un-inflated alternative to t.

Dependencies: numpy, nibabel, nilearn, scipy, matplotlib (all via nilearn).
    pip install numpy nibabel nilearn
"""
import os
import io
import glob
import base64
import numpy as np
import nibabel as nib
from nilearn.image import resample_to_img

import matplotlib
matplotlib.use("Agg")

# --- EDIT THIS: point to your lesion (or a folder of lesions for overlap) ---- #
DEFAULT_LESION = r"D:\Downloads in D\DALN mapper-20260702T124130Z-3-001\DALN mapper\Lesions\Palamanda-Sai-Mahesh_227909F_lesion_MNI.nii"
DEFAULT_BUNDLE = r"D:\Downloads in D\DALN mapper-20260702T124130Z-3-001\DALN mapper\lnm_bundle_d100.npz"
DEFAULT_LESION_DIR = ""            # set to a folder to run cohort overlap
DEFAULT_OUT_DIR = ""              # "" -> auto folder next to the lesion
DEFAULT_METRIC = "t"             # "t" (one-sample t) or "z" (Fisher-z effect size)
DEFAULT_THRESHOLD = 11.0           # |t| threshold (metric t)
DEFAULT_ZTHR = 0.2                # |z| threshold (metric z)
DEFAULT_PTHR = None               # set (e.g. 0.00005) to derive |t| from df instead
DEFAULT_DEGREE_ADJUST = True      # DA-LNM by default
DEFAULT_SPECIFICITY = True        # randomized-lesion specificity test
DEFAULT_NPERM = 100              # random lesions / cohorts for the specificity null
DEFAULT_ALPHA = 0.05
DEFAULT_SAMPLING_MASK = ""        # restrict random-lesion draws; "" = whole brain
# ---------------------------------------------------------------------------- #


def _t_threshold(pval, df):
    from scipy.stats import t as _t
    return float(_t.isf(pval / 2.0, df))


def _stem(p):
    b = os.path.basename(p)
    for ext in (".nii.gz", ".nii"):
        if b.lower().endswith(ext):
            return b[:-len(ext)]
    return os.path.splitext(b)[0]


def _fdr_bh(pvals, alpha):
    p = np.asarray(pvals)
    if p.size == 0:
        return np.zeros(0, bool)
    order = np.argsort(p)
    ranked = p[order] * p.size / (np.arange(p.size) + 1)
    passed = ranked <= alpha
    thresh = p[order][passed].max() if passed.any() else -1.0
    return p <= thresh


def _outputs(stem, outdir, metric):
    j = lambda s: os.path.join(outdir, stem + s)
    return {
        "raw": j(f"_{metric}_raw.nii.gz"),
        "da": j(f"_{metric}_DA.nii.gz"),
        "thresh_cont": j("_thresh_cont.nii.gz"),
        "pos_bin": j("_network_pos_bin.nii.gz"),
        "neg_bin": j("_network_neg_bin.nii.gz"),
        "spec_score": j("_specificity_zscore.nii.gz"),
        "spec_net": j("_specificity_network.nii.gz"),   # <-- primary result
        "html": j("_report.html"),
    }


class Connectome:
    def __init__(self, bundle_path):
        z = np.load(bundle_path)
        self.A = z["A"]; self.mask = z["mask"]; self.affine = z["affine"]
        self.grid = tuple(int(g) for g in z["grid"])
        self.covs = z["covs"]; self.G = z["G"]
        self.D = int(z["dim"]); self.N = self.covs.shape[0]
        self.ref = nib.Nifti1Image(self.mask.astype(np.float32), self.affine)
        # normative degree = row-sum of the low-rank CORRELATION connectome
        dvar = np.clip(((self.A @ self.G) * self.A).sum(1), 1e-12, None)
        An = self.A / np.sqrt(dvar)[:, None]
        self._degree = An @ (self.G @ An.sum(0))
        self.coords = np.argwhere(self.mask).astype(np.float32)
        self._var_node = np.einsum("ndd->nd", self.covs)
        # MNI152 brain mask (intersected with the bundle mask) to bound outputs
        self.brain = np.ones(self.A.shape[0], bool)
        try:
            from nilearn.datasets import load_mni152_brain_mask
            try:
                bm = load_mni152_brain_mask(resolution=2)
            except TypeError:
                bm = load_mni152_brain_mask()
            bm = resample_to_img(bm, self.ref, interpolation="nearest",
                                 force_resample=True, copy_header=True)
            self.brain = (np.asarray(bm.get_fdata()) > 0.5)[self.mask]
        except Exception as e:
            print(f"[warn] MNI brain mask unavailable, using full bundle mask: {e}")

    def _mask_brain(self, vec):
        return np.where(self.brain, np.asarray(vec), 0.0)

    def _load_lesion(self, lesion_path):
        les = resample_to_img(nib.load(lesion_path), self.ref,
                              interpolation="nearest",
                              force_resample=True, copy_header=True)
        idx = (np.asarray(les.get_fdata()) > 0.5)[self.mask]
        if idx.sum() == 0:
            raise ValueError("Lesion does not overlap the connectome brain mask "
                             "after resampling. Check MNI space / orientation.")
        return idx

    def _to_img(self, stat_vec):
        vol = np.zeros(self.grid, np.float32)
        vol[self.mask] = np.asarray(stat_vec, np.float32)
        return nib.Nifti1Image(vol, self.affine)

    def _maps_from_w(self, w):
        """Return (t_map, z_map): one-sample t and group-average Fisher-z (effect
        size) seed-to-voxel maps for seed loading vector w."""
        wS = np.einsum("d,ndc->nc", w, self.covs)
        var_seed = np.einsum("nc,c->n", wS, w)
        denom = np.sqrt(np.clip(var_seed[:, None] * self._var_node, 1e-12, None))
        zc = np.arctanh(np.clip(wS / denom, -0.999999, 0.999999))
        mean_z = zc.mean(0); Cz = np.cov(zc, rowvar=False)
        z_map = self.A @ mean_z                              # group-average Fisher-z
        var_map = ((self.A @ Cz) * self.A).sum(1)
        t_map = z_map / (np.sqrt(var_map / self.N) + 1e-12)  # one-sample t
        return t_map, z_map

    def _adjust(self, stat):
        deg = self._degree
        r_before = float(np.corrcoef(stat, deg)[0, 1])
        Xd = np.column_stack([np.ones_like(deg),
                              (deg - deg.mean()) / (deg.std() + 1e-12)])
        beta, *_ = np.linalg.lstsq(Xd, stat, rcond=None)
        corr = stat - Xd @ beta
        r_after = float(np.corrcoef(corr, deg)[0, 1])
        return corr, r_before, r_after

    def metric_from_w(self, w, degree_adjust, metric):
        t_map, z_map = self._maps_from_w(w)
        base = z_map if metric == "z" else t_map
        return self._adjust(base)[0] if degree_adjust else base

    def stat_for_indices(self, les_idx, degree_adjust, metric):
        w = self.A[les_idx].mean(0)
        t_map, z_map = self._maps_from_w(w)
        base = z_map if metric == "z" else t_map
        if degree_adjust:
            corr, rb, ra = self._adjust(base)
            return corr, base, rb, ra
        return base, base, float(np.corrcoef(base, self._degree)[0, 1]), None

    def random_lesion(self, vvox, pool_idx, rng):
        ci = pool_idx[rng.integers(pool_idx.size)]
        d2 = ((self.coords[pool_idx] - self.coords[ci]) ** 2).sum(1)
        k = min(vvox, pool_idx.size)
        take = pool_idx[np.argpartition(d2, k - 1)[:k]]
        m = np.zeros(self.A.shape[0], bool); m[take] = True
        return m

    def specificity(self, real_stat, vvox, degree_adjust, metric, tc, nperm,
                    pool_idx, alpha, use_fdr, rng):
        V = self.A.shape[0]
        null = np.empty((nperm, V), np.float32)
        for i in range(nperm):
            m = self.random_lesion(vvox, pool_idx, rng)
            null[i] = self.metric_from_w(self.A[m].mean(0), degree_adjust, metric)
        mean = null.mean(0); std = null.std(0) + 1e-12
        zmap = (real_stat - mean) / std
        p_pos = (1 + (null >= real_stat).sum(0)) / (nperm + 1)
        p_neg = (1 + (null <= real_stat).sum(0)) / (nperm + 1)
        supra_pos = real_stat >= tc; supra_neg = real_stat <= -tc
        if use_fdr:
            sig_pos = np.zeros(V, bool); sig_neg = np.zeros(V, bool)
            sig_pos[supra_pos] = _fdr_bh(p_pos[supra_pos], alpha)
            sig_neg[supra_neg] = _fdr_bh(p_neg[supra_neg], alpha)
        else:
            sig_pos = supra_pos & (p_pos < alpha)
            sig_neg = supra_neg & (p_neg < alpha)
        sig_pos &= self.brain; sig_neg &= self.brain
        return {"z": self._mask_brain(zmap), "sig_pos": sig_pos, "sig_neg": sig_neg,
                "n_sig_pos": int(sig_pos.sum()), "n_sig_neg": int(sig_neg.sum())}


# --------------------------------------------------------------------------- #
#  Atlas labelling
# --------------------------------------------------------------------------- #
def _as_img(x):
    return nib.load(x) if isinstance(x, str) else x


def _resample_labels(atlas_img, ref_img):
    a = resample_to_img(_as_img(atlas_img), ref_img, interpolation="nearest",
                        force_resample=True, copy_header=True)
    d = np.asarray(a.get_fdata())
    return (d[..., 0] if d.ndim == 4 else d).astype(int)


def _harvard_oxford(ref_img):
    from nilearn import datasets
    cort = datasets.fetch_atlas_harvard_oxford("cort-maxprob-thr25-2mm")
    sub = datasets.fetch_atlas_harvard_oxford("sub-maxprob-thr25-2mm")
    c, s = _resample_labels(cort.maps, ref_img), _resample_labels(sub.maps, ref_img)
    names, vol = {}, np.zeros(c.shape, int)
    for i, l in enumerate(cort.labels):
        if i:
            names[i] = l
    vol[c > 0] = c[c > 0]
    off = len(cort.labels)
    skip = ("Cerebral Cortex", "White Matter", "Lateral Ventric")
    for i, l in enumerate(sub.labels):
        if i and not any(k in l for k in skip):
            names[off + i] = l
    fill = (vol == 0) & (s > 0)
    vol[fill] = off + s[fill]
    return vol, names


def _yeo7(ref_img):
    from nilearn import datasets
    y = datasets.fetch_atlas_yeo_2011()
    img = getattr(y, "thick_7", None) or (y["thick_7"] if "thick_7" in y else y.maps)
    names = {1: "Visual", 2: "Somatomotor", 3: "DorsalAttention",
             4: "VentralAttention", 5: "Limbic", 6: "Frontoparietal", 7: "Default"}
    return _resample_labels(img, ref_img), names


def _table(label_vol, names, tail_mask, vmap, top):
    vals, tv = label_vol[tail_mask], vmap[tail_mask]
    total = max(int(tail_mask.sum()), 1)
    rows = []
    for idx in np.unique(vals):
        if idx <= 0 or idx not in names:
            continue
        sel = vals == idx
        rows.append((names[idx], int(sel.sum()),
                     100.0 * int(sel.sum()) / total, float(tv[sel].mean())))
    rows.sort(key=lambda r: -r[1])
    return rows[:top]


def region_tables(vmap_img, tc, top=10, use_atlases=True):
    """Region breakdown of a (already thresholded/filtered) map's pos/neg tails."""
    timg = _as_img(vmap_img)
    t = np.asarray(timg.get_fdata())
    pos, neg = t >= tc, t <= -tc
    tables = {"n_pos": int(pos.sum()), "n_neg": int(neg.sum())}
    if not use_atlases:
        return tables
    for loader, key in ((_harvard_oxford, "ho"), (_yeo7, "yeo")):
        try:
            vol, names = loader(timg)
        except Exception as e:
            tables[f"{key}_err"] = str(e)
            continue
        for tail, m in (("pos", pos), ("neg", neg)):
            tables[f"{key}_{tail}"] = _table(vol, names, m, t, top) if m.any() else []
    return tables


# --------------------------------------------------------------------------- #
#  MNI overlay -> base64 PNG
# --------------------------------------------------------------------------- #
def _mni_bg():
    from nilearn.datasets import load_mni152_template
    try:
        return load_mni152_template(resolution=2)
    except TypeError:
        return load_mni152_template()


def _cut(lesion_path):
    from nilearn import plotting
    try:
        return plotting.find_xyz_cut_coords(nib.load(lesion_path)) if lesion_path else None
    except Exception:
        return None


def _static_png(net_img, tc, title, lesion_path=None):
    """Static overlay: light background, sub-threshold voxels transparent."""
    from nilearn import plotting
    try:
        d = plotting.plot_stat_map(net_img, bg_img=_mni_bg(), threshold=tc,
                                   cut_coords=_cut(lesion_path), colorbar=True,
                                   draw_cross=False, black_bg=False, cmap="cold_hot",
                                   title=title)
        if lesion_path:
            try:
                d.add_contours(nib.load(lesion_path), levels=[0.5],
                               colors="lime", linewidths=1.5)
            except Exception:
                pass
        buf = io.BytesIO(); d.savefig(buf, dpi=120); d.close()
        return base64.b64encode(buf.getvalue()).decode(), None
    except Exception as e:
        return None, str(e)


def _mosaic_png(net_img, tc, lesion_path=None, dpi=145):
    """Light multi-slice mosaic (all three planes) — fallback if the viewer fails."""
    from nilearn import plotting
    try:
        d = plotting.plot_stat_map(net_img, bg_img=_mni_bg(), threshold=tc,
                                   display_mode="mosaic", colorbar=True,
                                   black_bg=False, cmap="cold_hot")
        if lesion_path:
            try:
                d.add_contours(nib.load(lesion_path), levels=[0.5],
                               colors="lime", linewidths=1.2)
            except Exception:
                pass
        buf = io.BytesIO(); d.savefig(buf, dpi=dpi); d.close()
        return base64.b64encode(buf.getvalue()).decode(), None
    except Exception as e:
        return None, str(e)


def _interactive_html(net_img, tc, lesion_path=None):
    """Interactive, scrollable MNI viewer (scroll slices, drag, hover values)."""
    from nilearn import plotting
    try:
        view = plotting.view_img(net_img, bg_img=_mni_bg(), threshold=float(tc),
                                 cmap="cold_hot", symmetric_cmap=True, colorbar=True,
                                 black_bg=False, opacity=0.9, cut_coords=_cut(lesion_path))
        return view.get_iframe(), None
    except Exception as e:
        return None, str(e)


# --------------------------------------------------------------------------- #
#  HTML report
# --------------------------------------------------------------------------- #
_CSS = """
:root{--navy:#16324f;--blue:#2563a8;--slate:#475569;--line:#e4e9f0;--bg:#f5f7fb;
--card:#ffffff;--accent:#0e7490}
*{box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;
background:var(--bg);color:#1a2433;line-height:1.55;font-size:15px}
.wrap{max-width:960px;margin:0 auto;padding:0 26px 56px}
header{background:linear-gradient(135deg,#16324f 0%,#2563a8 100%);color:#fff;
padding:30px 0 26px;box-shadow:0 2px 12px rgba(16,50,79,.18)}
header .wrap{padding-bottom:0}
header h1{font-size:23px;font-weight:600;margin:0 0 5px;letter-spacing:.2px}
header .sub{opacity:.9;font-size:13.5px;margin:0;font-family:ui-monospace,Consolas,monospace}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:20px 24px;margin:18px 0;box-shadow:0 1px 3px rgba(16,24,40,.05)}
.card.primary{border:1px solid #b9d5f0;box-shadow:0 4px 16px rgba(37,99,168,.12)}
.card.primary h2{color:var(--blue)}
h2{font-size:16px;color:var(--navy);margin:0 0 14px;font-weight:650;
display:flex;align-items:center;gap:8px}
h2 .tag{font-size:10.5px;font-weight:600;color:#fff;background:var(--accent);
padding:2px 8px;border-radius:20px;letter-spacing:.04em;text-transform:uppercase}
h3{font-size:12px;color:var(--slate);margin:16px 0 6px;font-weight:700;
text-transform:uppercase;letter-spacing:.06em}
.methods{font-size:13.5px;color:#334155;background:#eef4fb;border-left:3px solid var(--blue);
border-radius:0 8px 8px 0;padding:13px 18px}
.methods b{color:var(--navy)}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:4px 0 10px}
thead th{background:var(--navy);color:#fff;text-align:left;padding:8px 12px;
font-weight:600;font-size:12px;letter-spacing:.02em}
tbody td{padding:7px 12px;border-bottom:1px solid var(--line)}
tbody td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
tbody tr:nth-child(even){background:#f8fafc}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin:4px 0}
.stat{background:#f8fafc;border:1px solid var(--line);border-radius:9px;padding:11px 15px}
.stat .l{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.stat .v{font-size:19px;font-weight:650;color:var(--navy);margin-top:3px;
font-variant-numeric:tabular-nums}
.stat .v small{font-size:12px;font-weight:500;color:#64748b}
.viewer{width:100%;height:560px;border:1px solid var(--line);border-radius:10px;
overflow:auto;background:#fff;margin:4px 0}
.viewer iframe{width:100%;height:100%;border:0;display:block}
.viewer img{max-width:none;border:0;border-radius:0}
.hint{font-size:12px;color:#64748b;margin:6px 0 0}
figure{margin:8px 0}figcaption{font-size:12.5px;color:#64748b;margin-top:6px}
img{max-width:100%;border:1px solid var(--line);border-radius:8px;display:block}
.legend{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:10px 0 2px;
font-size:12.5px;color:#475569}
.legend .chip{display:inline-flex;align-items:center;gap:7px}
.legend .sw{width:34px;height:12px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.12)}
.muted{color:#94a3b8;font-style:italic;font-size:13px}
footer{color:#94a3b8;font-size:11.5px;text-align:center;margin-top:26px}
"""


def _legend(unit):
    return (f"""<div class="legend">
<span class="chip"><span class="sw" style="background:linear-gradient(90deg,#7a0a0a,#ff9d3c)"></span>
positive &mdash; coupled to the lesion</span>
<span class="chip"><span class="sw" style="background:linear-gradient(90deg,#0a2e7a,#4fb0ff)"></span>
negative &mdash; anticorrelated</span>
<span>Colour scale: {unit}. Green outline = lesion.</span></div>""")


def _html_tbl(title, rows, cols):
    if rows is None:
        return f"<h3>{title}</h3><p class='muted'>Atlas labelling unavailable.</p>"
    if not rows:
        return f"<h3>{title}</h3><p class='muted'>No voxels in this tail.</p>"
    head = "".join(f"<th>{c}</th>" for c in cols)
    body = "".join(
        f"<tr><td>{nm}</td><td>{n}</td><td>{pct:.1f}%</td><td>{mt:+.2f}</td></tr>"
        for nm, n, pct, mt in rows)
    return (f"<h3>{title}</h3><table><thead><tr>{head}</tr></thead>"
            f"<tbody>{body}</tbody></table>")


def _fig(imgs, key, cap):
    if imgs.get(key):
        return (f"<figure><img src='data:image/png;base64,{imgs[key]}'>"
                f"<figcaption class='muted'>{cap}</figcaption></figure>")
    return f"<p class='muted'>Figure unavailable: {imgs.get(key + '_err', 'n/a')}</p>"


def build_html(summary, tables, imgs, out_html):
    is_z = summary["metric"] == "z"
    mlabel = "z" if is_z else "t"
    unit = ("Fisher-z connectivity (effect size)" if is_z
            else f"one-sample t (N={summary['N']})")
    stat_name = ("group-average Fisher-z connectivity (effect size)" if is_z
                 else "one-sample t across the normative subjects")
    cols = ["Region", "Voxels", "% of tail", f"Mean {mlabel}"]
    ncols = ["Network", "Voxels", "% of tail", f"Mean {mlabel}"]
    ho_note = (f"<p class='muted'>Harvard-Oxford unavailable: {tables['ho_err']}</p>"
               if "ho_err" in tables else "")
    yeo_note = (f"<p class='muted'>Yeo-7 unavailable: {tables['yeo_err']}</p>"
                if "yeo_err" in tables else "")
    adj = "degree-adjusted" if summary["adjusted"] else "not degree-adjusted"
    spec = summary.get("spec")
    tables_src = "specificity-filtered network" if spec else "thresholded network"

    # primary panel: interactive scrollable viewer (mosaic image as fallback)
    if imgs.get("primary_iframe"):
        primary_view = (f'<div class="viewer">{imgs["primary_iframe"]}</div>'
                        '<p class="hint">Interactive &mdash; scroll to move through '
                        'slices, drag to reposition, hover for values.</p>')
    elif imgs.get("primary_png"):
        primary_view = (f'<div class="viewer"><img src="data:image/png;base64,'
                        f'{imgs["primary_png"]}"></div>'
                        '<p class="hint">Scroll within the panel to view all slices.</p>')
    else:
        primary_view = f"<p class='muted'>Figure unavailable: {imgs.get('primary_err','n/a')}</p>"
    ptitle = ("specificity-filtered network" if spec else "thresholded network")

    ra = summary["r_after_str"]
    stat_cards = f"""<div class="grid">
<div class="stat"><div class="l">Lesion volume</div><div class="v">{summary['lesion_voxels']} <small>vox</small></div></div>
<div class="stat"><div class="l">Threshold</div><div class="v">|{mlabel}| &ge; {summary['tc']:.3g}</div></div>
<div class="stat"><div class="l">Supra-threshold</div><div class="v">{summary['n_pos_thr']}<small> pos</small> / {summary['n_neg_thr']}<small> neg</small></div></div>
{'<div class="stat"><div class="l">Specificity survivors</div><div class="v">'+str(spec['n_sig_pos'])+'<small> pos</small> / '+str(spec['n_sig_neg'])+'<small> neg</small></div></div>' if spec else ''}
<div class="stat"><div class="l">Degree r (before&rarr;after)</div><div class="v">{summary['r_before']:.2f}<small> &rarr; {ra}</small></div></div>
<div class="stat"><div class="l">Connectome</div><div class="v">{summary['N']}<small> subj, D={summary['D']}</small></div></div>
</div>"""

    methods = f"""<div class="methods"><b>Methods.</b> The lesion was used as a seed
in the HCP&nbsp;S1200 normative connectome (N={summary['N']}, {summary['D']}-component
low-rank model). Its connectivity to every brain voxel was computed per subject and
Fisher-z transformed, summarised as a {stat_name}, and {adj} by regressing out the
connectome's correlation degree. The map was restricted to the MNI152 brain and
thresholded at |{mlabel}|&nbsp;&ge;&nbsp;{summary['tc']:.3g}{summary['thr_note']}. A
volume-matched randomized-lesion null
({spec['nperm'] if spec else 0} permutations, &alpha;={spec['alpha'] if spec else '&mdash;'}
{', FDR-corrected' if (spec and spec['fdr']) else ''}) then retained only voxels more
strongly connected than chance &mdash; the primary result shown below. Region
statistics are computed on the {tables_src}.</div>"""

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>DA-LNM report &mdash; {summary['lesion']}</title><style>{_CSS}</style></head><body>
<header><div class="wrap">
<h1>Degree-Adjusted Lesion Network Mapping</h1>
<p class="sub">{summary['lesion']}</p></div></header>
<div class="wrap">

<div class="card">{methods}</div>

<div class="card primary">
<h2>Primary result <span class="tag">specificity-filtered</span></h2>
{primary_view}
{_legend(unit)}
<figcaption>Voxels whose {stat_name} exceeds volume-matched randomized lesions
(the {ptitle}), displayed on the MNI152 template.</figcaption>
</div>

<div class="card">
<h2>Summary</h2>
{stat_cards}
</div>

<div class="card">
<h2>Supporting map</h2>
{_fig(imgs, "support", "Thresholded network before the specificity filter (static section view).")}
{_legend(unit)}
</div>

<div class="card">
<h2>Anatomical labelling <span class="tag">Harvard-Oxford</span></h2>
<p class="muted">Regions of the {tables_src}.</p>
{ho_note}
{_html_tbl("Positive (coupled) network", tables.get("ho_pos"), cols)}
{_html_tbl("Negative (anticorrelated) network", tables.get("ho_neg"), cols)}
</div>

<div class="card">
<h2>Functional networks <span class="tag">Yeo-7</span></h2>
<p class="muted">Networks of the {tables_src}.</p>
{yeo_note}
{_html_tbl("Positive (coupled) network", tables.get("yeo_pos"), ncols)}
{_html_tbl("Negative (anticorrelated) network", tables.get("yeo_neg"), ncols)}
</div>

<footer>Generated by lnm_backend.py (v1.8) &middot; maps in MNI152 2&nbsp;mm space</footer>
</div></body></html>"""
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)
    return out_html


# --------------------------------------------------------------------------- #
def _pool_indices(conn, sampling_mask_path):
    if not sampling_mask_path:
        return np.flatnonzero(conn.brain)
    sm = resample_to_img(nib.load(sampling_mask_path), conn.ref,
                         interpolation="nearest", force_resample=True, copy_header=True)
    keep = ((np.asarray(sm.get_fdata()) > 0.5)[conn.mask]) & conn.brain
    idx = np.flatnonzero(keep)
    if idx.size == 0:
        raise SystemExit("Sampling mask does not overlap the connectome brain mask.")
    return idx


# --------------------------------------------------------------------------- #
def run_single(conn, lesion, outdir, tc, thr_note, metric, degree_adjust, top,
               use_atlases, html, spec_cfg):
    os.makedirs(outdir, exist_ok=True)
    outs = _outputs(_stem(lesion), outdir, metric)
    les_idx = conn._load_lesion(lesion); vvox = int(les_idx.sum())
    stat, raw, rb, ra = conn.stat_for_indices(les_idx, degree_adjust, metric)
    stat = conn._mask_brain(stat); raw = conn._mask_brain(raw)

    nib.save(conn._to_img(raw), outs["raw"])
    if degree_adjust:
        nib.save(conn._to_img(stat), outs["da"])
    cont = stat.copy(); cont[np.abs(cont) < tc] = 0.0
    img_cont = conn._to_img(cont)
    nib.save(img_cont, outs["thresh_cont"])
    n_pos_thr = int((stat >= tc).sum()); n_neg_thr = int((stat <= -tc).sum())

    print(f"output folder           : {outdir}")
    print(f"lesion voxels           : {vvox}")
    print(f"metric / threshold      : {metric} | |{metric}| >= {tc:.3g}{thr_note}")
    print(f"statistic               : {'degree-adjusted' if degree_adjust else 'raw'}")
    print(f"degree r before -> after: {rb:.3f} -> {('%.3f' % ra) if ra is not None else 'n/a'}")
    print(f"supra-threshold voxels  : {n_pos_thr} pos / {n_neg_thr} neg")

    spec = None; main_vec = cont
    # binary masks: POST-specificity when the test is run, else thresholded
    pos_bin = (stat >= tc); neg_bin = (stat <= -tc)
    if spec_cfg["run"]:
        rng = np.random.default_rng(spec_cfg["seed"])
        print(f"specificity             : {spec_cfg['nperm']} random lesions "
              f"(vol={vvox}), alpha={spec_cfg['alpha']}"
              f"{' FDR' if spec_cfg['fdr'] else ''} ... (this is the slow step)")
        spec = conn.specificity(stat, vvox, degree_adjust, metric, tc,
                                spec_cfg["nperm"], spec_cfg["pool"],
                                spec_cfg["alpha"], spec_cfg["fdr"], rng)
        pos_bin = spec["sig_pos"]; neg_bin = spec["sig_neg"]     # <-- post-specificity
        sig = spec["sig_pos"] | spec["sig_neg"]
        main_vec = np.where(sig, stat, 0.0)
        nib.save(conn._to_img(spec["z"]), outs["spec_score"])
        nib.save(conn._to_img(main_vec), outs["spec_net"])
        print(f"  survives specificity  : {spec['n_sig_pos']} pos / {spec['n_sig_neg']} neg")

    nib.save(conn._to_img(pos_bin.astype(np.float32)), outs["pos_bin"])
    nib.save(conn._to_img(neg_bin.astype(np.float32)), outs["neg_bin"])

    # region statistics computed on the PRIMARY result (specificity net if present)
    tables = region_tables(conn._to_img(main_vec), tc, top=top, use_atlases=use_atlases)

    if html:
        imgs = {}
        primary_img = conn._to_img(main_vec)      # specificity net, or thresholded if no spec
        imgs["primary_iframe"], imgs["primary_err"] = _interactive_html(
            primary_img, tc, lesion_path=lesion)
        if not imgs["primary_iframe"]:            # fallback: light static mosaic
            imgs["primary_png"], _ = _mosaic_png(primary_img, tc, lesion_path=lesion)
        imgs["support"], imgs["support_err"] = _static_png(img_cont, tc,
            "Thresholded network on MNI152", lesion_path=lesion)
        summary = {"lesion": os.path.basename(lesion), "lesion_voxels": vvox,
                   "N": conn.N, "D": conn.D, "adjusted": degree_adjust,
                   "metric": metric, "tc": tc, "thr_note": thr_note,
                   "n_pos_thr": n_pos_thr, "n_neg_thr": n_neg_thr,
                   "r_before": rb, "r_after_str": ("%.3f" % ra) if ra is not None else "n/a",
                   "spec": (dict(nperm=spec_cfg["nperm"], alpha=spec_cfg["alpha"],
                                 fdr=spec_cfg["fdr"], n_sig_pos=spec["n_sig_pos"],
                                 n_sig_neg=spec["n_sig_neg"]) if spec else None)}
        build_html(summary, tables, imgs, outs["html"])

    for k in ("raw", "da", "thresh_cont", "pos_bin", "neg_bin", "spec_score",
              "spec_net", "html"):
        if os.path.exists(outs[k]):
            print(f"  {k:11s}: {os.path.basename(outs[k])}")


# --------------------------------------------------------------------------- #
def run_overlap(conn, lesion_dir, outdir, tc, thr_note, metric, degree_adjust,
                html, spec_cfg):
    os.makedirs(outdir, exist_ok=True)
    skip = ("_t_raw", "_z_raw", "_t_DA", "_z_DA", "_thresh_cont", "_network_pos_bin",
            "_network_neg_bin", "_specificity", "LNM_overlap")
    files = sorted([f for e in ("*.nii", "*.nii.gz")
                    for f in glob.glob(os.path.join(lesion_dir, e))
                    if not any(t in os.path.basename(f) for t in skip)])
    if not files:
        raise SystemExit(f"No lesion .nii/.nii.gz files found in {lesion_dir}")
    print(f"output folder : {outdir}")
    print(f"[overlap] {len(files)} lesions | metric={metric} |{metric}|>={tc:.3g} | "
          f"{'degree-adjusted' if degree_adjust else 'raw'}")

    V = conn.A.shape[0]
    pos_ct = np.zeros(V, np.int32); neg_ct = np.zeros(V, np.int32)
    vvox_list, ok = [], 0
    for f in files:
        try:
            idx = conn._load_lesion(f)
            stat = conn._mask_brain(conn.stat_for_indices(idx, degree_adjust, metric)[0])
        except Exception as e:
            print(f"  skip {os.path.basename(f)}: {e}"); continue
        pos_ct += (stat >= tc); neg_ct += (stat <= -tc)
        vvox_list.append(int(idx.sum())); ok += 1
        print(f"  {os.path.basename(f)}: +{int((stat>=tc).sum())} / -{int((stat<=-tc).sum())}")

    p_pos = os.path.join(outdir, "LNM_overlap_positive.nii.gz")
    p_neg = os.path.join(outdir, "LNM_overlap_negative.nii.gz")
    nib.save(conn._to_img(pos_ct.astype(np.float32)), p_pos)
    nib.save(conn._to_img(neg_ct.astype(np.float32)), p_neg)
    print(f"[overlap] {ok}/{len(files)} used; peak +{int(pos_ct.max())} / -{int(neg_ct.max())}")

    spec = None; spec_pos = spec_neg = None
    if spec_cfg["run"] and ok:
        rng = np.random.default_rng(spec_cfg["seed"]); pool = spec_cfg["pool"]; M = spec_cfg["nperm"]
        print(f"[overlap] specificity: {M} randomized cohorts ... (slow)")
        null_pos = np.empty((M, V), np.float32); null_neg = np.empty((M, V), np.float32)
        for j in range(M):
            pc = np.zeros(V, np.int32); nc = np.zeros(V, np.int32)
            for vv in vvox_list:
                s = conn._mask_brain(conn.metric_from_w(
                    conn.A[conn.random_lesion(vv, pool, rng)].mean(0), degree_adjust, metric))
                pc += (s >= tc); nc += (s <= -tc)
            null_pos[j] = pc; null_neg[j] = nc
        pp = (1 + (null_pos >= pos_ct).sum(0)) / (M + 1)
        pn = (1 + (null_neg >= neg_ct).sum(0)) / (M + 1)
        if spec_cfg["fdr"]:
            sig_pos = _fdr_bh(pp, spec_cfg["alpha"]); sig_neg = _fdr_bh(pn, spec_cfg["alpha"])
        else:
            sig_pos = pp < spec_cfg["alpha"]; sig_neg = pn < spec_cfg["alpha"]
        sig_pos &= conn.brain; sig_neg &= conn.brain
        spec_pos = np.where(sig_pos, pos_ct, 0).astype(np.float32)
        spec_neg = np.where(sig_neg, neg_ct, 0).astype(np.float32)
        nib.save(conn._to_img(spec_pos), os.path.join(outdir, "LNM_overlap_positive_SPECIFIC.nii.gz"))
        nib.save(conn._to_img(spec_neg), os.path.join(outdir, "LNM_overlap_negative_SPECIFIC.nii.gz"))
        spec = {"n_sig_pos": int(sig_pos.sum()), "n_sig_neg": int(sig_neg.sum())}
        print(f"  specific overlap: {spec['n_sig_pos']} pos / {spec['n_sig_neg']} neg voxels")

    if html:
        imgs = {}
        primary_ct = spec_pos if spec is not None else pos_ct.astype(np.float32)
        primary_img = conn._to_img(primary_ct.astype(np.float32))
        imgs["primary_iframe"], imgs["primary_err"] = _interactive_html(primary_img, 1)
        if not imgs["primary_iframe"]:
            imgs["primary_png"], _ = _mosaic_png(primary_img, 1)
        imgs["pos"], imgs["pos_err"] = _static_png(conn._to_img(pos_ct.astype(np.float32)), 1,
            "Positive overlap")
        imgs["neg"], imgs["neg_err"] = _static_png(conn._to_img(neg_ct.astype(np.float32)), 1,
            "Negative overlap")
        adj = "degree-adjusted" if degree_adjust else "raw"
        stat_name = "Fisher-z effect size" if metric == "z" else "one-sample t"
        unit = "overlap count (number of lesions)"
        if imgs.get("primary_iframe"):
            pview = (f'<div class="viewer">{imgs["primary_iframe"]}</div>'
                     '<p class="hint">Interactive &mdash; scroll through slices, hover for the count.</p>')
        elif imgs.get("primary_png"):
            pview = (f'<div class="viewer"><img src="data:image/png;base64,'
                     f'{imgs["primary_png"]}"></div>'
                     '<p class="hint">Scroll within the panel to view all slices.</p>')
        else:
            pview = f"<p class='muted'>Figure unavailable: {imgs.get('primary_err','n/a')}</p>"
        ptag = "specificity-filtered" if spec is not None else "unfiltered"
        pcap = ("Overlap voxels surviving the randomized-cohort specificity test."
                if spec is not None else "Cohort overlap (specificity test not run).")
        methods = (f"""<div class="methods"><b>Methods.</b> Each lesion's {stat_name}
network ({adj}, degree) was thresholded at |{metric}|&ge;{tc:.3g}, binarized (both
tails) and summed across the cohort (Boes et al. step iii). A randomized-cohort null
(volume-matched lesions, {spec_cfg['nperm']} iterations, &alpha;={spec_cfg['alpha']}
{', FDR' if spec_cfg['fdr'] else ''}) identified overlap voxels exceeding chance,
forming the primary result.</div>""")
        spec_card = ('<div class="stat"><div class="l">Specific overlap</div><div class="v">'
                     + str(spec['n_sig_pos']) + '<small> pos</small> / '
                     + str(spec['n_sig_neg']) + '<small> neg</small></div></div>') if spec else ''
        out_html = os.path.join(outdir, "LNM_overlap_report.html")
        with open(out_html, "w", encoding="utf-8") as fh:
            fh.write(f"""<!doctype html><html><head><meta charset="utf-8">
<title>DA-LNM cohort overlap</title><style>{_CSS}</style></head><body>
<header><div class="wrap"><h1>Lesion Network Mapping &mdash; cohort overlap</h1>
<p class="sub">{ok} of {len(files)} lesions &middot; {stat_name} &middot; {adj}</p></div></header>
<div class="wrap">
<div class="card">{methods}</div>
<div class="card primary"><h2>Primary result <span class="tag">{ptag}</span></h2>
{pview}{_legend(unit)}<figcaption>{pcap}</figcaption></div>
<div class="card"><h2>Summary</h2><div class="grid">
<div class="stat"><div class="l">Lesions used</div><div class="v">{ok}<small> / {len(files)}</small></div></div>
<div class="stat"><div class="l">Threshold</div><div class="v">|{metric}| &ge; {tc:.3g}</div></div>
<div class="stat"><div class="l">Peak overlap</div><div class="v">{int(pos_ct.max())}<small> pos</small> / {int(neg_ct.max())}<small> neg</small></div></div>
{spec_card}
<div class="stat"><div class="l">Connectome</div><div class="v">{conn.N}<small> subj, D={conn.D}</small></div></div>
</div></div>
<div class="card"><h2>Unfiltered overlap</h2>
{_fig(imgs, "pos", "Positive-correlation overlap across the cohort.")}
{_fig(imgs, "neg", "Negative-correlation overlap.")}{_legend(unit)}</div>
<footer>Generated by lnm_backend.py (v1.8) &middot; maps in MNI152 2&nbsp;mm space</footer>
</div></body></html>""")
        print(f"  report      : {os.path.basename(out_html)}")


# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--lesion", default=DEFAULT_LESION)
    ap.add_argument("--bundle", default=DEFAULT_BUNDLE)
    ap.add_argument("--lesion-dir", default=DEFAULT_LESION_DIR)
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR,
                    help='output folder ("" = auto folder next to the lesion)')
    ap.add_argument("--metric", choices=["t", "z"], default=DEFAULT_METRIC,
                    help="t = one-sample t (default); z = Fisher-z effect size")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                    help="|t| threshold (metric t)")
    ap.add_argument("--zthr", type=float, default=DEFAULT_ZTHR,
                    help="|z| threshold (metric z)")
    ap.add_argument("--pthr", type=float, default=DEFAULT_PTHR,
                    help="derive |t| from this uncorrected p (metric t; overrides --threshold)")
    ap.add_argument("--no-degree-adjust", dest="degree_adjust", action="store_false",
                    default=DEFAULT_DEGREE_ADJUST)
    ap.add_argument("--no-specificity", dest="specificity", action="store_false",
                    default=DEFAULT_SPECIFICITY)
    ap.add_argument("--nperm", type=int, default=DEFAULT_NPERM)
    ap.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)
    ap.add_argument("--fdr", action="store_true")
    ap.add_argument("--sampling-mask", default=DEFAULT_SAMPLING_MASK)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-brain-mask", dest="brain_mask", action="store_false", default=True)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--no-atlas", action="store_true")
    ap.add_argument("--no-html", action="store_true")
    a = ap.parse_args()

    conn = Connectome(a.bundle)
    if not a.brain_mask:
        conn.brain[:] = True

    if a.metric == "z":
        tc, thr_note = a.zthr, ""
    elif a.pthr is not None:
        tc = _t_threshold(a.pthr, conn.N - 1); thr_note = f" (P&lt;{a.pthr:g}, df={conn.N-1})"
    else:
        tc, thr_note = a.threshold, ""

    spec_cfg = {"run": a.specificity, "nperm": a.nperm, "alpha": a.alpha,
                "fdr": a.fdr, "seed": a.seed, "pool": _pool_indices(conn, a.sampling_mask)}

    if a.lesion_dir:
        outdir = a.out_dir or os.path.join(a.lesion_dir, "DALNM_group")
        run_overlap(conn, a.lesion_dir, outdir, tc, thr_note, a.metric, a.degree_adjust,
                    html=not a.no_html, spec_cfg=spec_cfg)
    else:
        outdir = a.out_dir or os.path.join(os.path.dirname(a.lesion),
                                           _stem(a.lesion) + "_DALNM")
        run_single(conn, a.lesion, outdir, tc, thr_note, a.metric, a.degree_adjust,
                   top=a.top, use_atlases=not a.no_atlas, html=not a.no_html, spec_cfg=spec_cfg)
