#!/usr/bin/env python3
"""lnm_backend.py -- Degree-Adjusted Lesion Network Mapping (DA-LNM) engine.

Volumetric, degree-corrected lesion network mapping from the compact HCP-PTN
bundle built by prepare_connectome.py. Seed-to-voxel connectivity is a rank-D
(= ICA dimensionality) reconstruction: it keeps per-subject variance, so the
output is a genuine one-sample t-map across the connectome subjects (or a
group-average Fisher-z effect-size map), and the normative-connectome degree
is regressed out.

This module holds the Connectome class (compute), atlas labelling (Harvard-
Oxford + Yeo-7 via nilearn datasets), and the HTML report builder. It is a
pure importable module -- no CLI, no module-level defaults. Orchestration
(output file naming, thresholds, the JSON result contract) lives in
lnm_worker.py.

Adapted from DaLnm/DaLn_mapper.v.2.1.py.

Dependencies: numpy, nibabel, nilearn, scipy, matplotlib (all via nilearn).
"""
import io
import base64
import numpy as np
import nibabel as nib
from nilearn.image import resample_to_img

import matplotlib
matplotlib.use("Agg")


def t_threshold(pval, df):
    """Derive a |t| threshold from an uncorrected two-tailed p-value."""
    from scipy.stats import t as _t
    return float(_t.isf(pval / 2.0, df))


def fdr_bh(pvals, alpha):
    """Benjamini-Hochberg FDR: returns a boolean mask of which p-values pass."""
    p = np.asarray(pvals)
    if p.size == 0:
        return np.zeros(0, bool)
    order = np.argsort(p)
    ranked = p[order] * p.size / (np.arange(p.size) + 1)
    passed = ranked <= alpha
    thresh = p[order][passed].max() if passed.any() else -1.0
    return p <= thresh


class Connectome:
    def __init__(self, bundle_path):
        z = np.load(bundle_path)
        self.A = z["A"]                 # V x D : component maps at brain voxels
        self.mask = z["mask"]           # X,Y,Z bool
        self.affine = z["affine"]
        self.grid = tuple(int(g) for g in z["grid"])
        self.covs = z["covs"]           # N x D x D : per-subject covariance
        self.G = z["G"]                 # D x D     : group covariance
        self.D = int(z["dim"])
        self.N = self.covs.shape[0]
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

    # -- lesion -> boolean index within the brain mask --------------------------
    def _load_lesion(self, lesion_path):
        les = resample_to_img(nib.load(lesion_path), self.ref,
                              interpolation="nearest",
                              force_resample=True, copy_header=True)
        idx = (np.asarray(les.get_fdata()) > 0.5)[self.mask]
        if idx.sum() == 0:
            raise ValueError(
                "Lesion does not overlap the connectome brain mask after "
                "resampling. Check the lesion is in MNI152 space and correctly "
                "oriented.")
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
                    pool_idx, alpha, use_fdr, rng, chunk=8):
        """Randomized-lesion permutation null. Volume-matched random lesions are
        drawn from pool_idx and their (optionally degree-adjusted) metric map is
        computed; the observed map is z-scored against this null, and voxels are
        retained if they both pass the raw threshold and beat the null at alpha
        (optionally BH-FDR corrected).

        Permutations are processed in chunks so each metric_from_w batch stays a
        single large BLAS call (float32 throughout) rather than nperm tiny ones.
        """
        V = self.A.shape[0]
        null = np.empty((nperm, V), np.float32)
        for start in range(0, nperm, chunk):
            end = min(start + chunk, nperm)
            for i in range(start, end):
                m = self.random_lesion(vvox, pool_idx, rng)
                null[i] = self.metric_from_w(self.A[m].mean(0), degree_adjust, metric)
        mean = null.mean(0); std = null.std(0) + 1e-12
        zmap = (real_stat - mean) / std
        p_pos = (1 + (null >= real_stat).sum(0)) / (nperm + 1)
        p_neg = (1 + (null <= real_stat).sum(0)) / (nperm + 1)
        supra_pos = real_stat >= tc; supra_neg = real_stat <= -tc
        if use_fdr:
            sig_pos = np.zeros(V, bool); sig_neg = np.zeros(V, bool)
            sig_pos[supra_pos] = fdr_bh(p_pos[supra_pos], alpha)
            sig_neg[supra_neg] = fdr_bh(p_neg[supra_neg], alpha)
        else:
            sig_pos = supra_pos & (p_pos < alpha)
            sig_neg = supra_neg & (p_neg < alpha)
        sig_pos &= self.brain; sig_neg &= self.brain
        return {"z": self._mask_brain(zmap), "sig_pos": sig_pos, "sig_neg": sig_neg,
                "n_sig_pos": int(sig_pos.sum()), "n_sig_neg": int(sig_neg.sum())}


def pool_indices(conn, sampling_mask_path=""):
    """Voxel-index pool from which random lesions are drawn (whole brain unless a
    sampling mask is supplied)."""
    if not sampling_mask_path:
        return np.flatnonzero(conn.brain)
    sm = resample_to_img(nib.load(sampling_mask_path), conn.ref,
                         interpolation="nearest", force_resample=True, copy_header=True)
    keep = ((np.asarray(sm.get_fdata()) > 0.5)[conn.mask]) & conn.brain
    idx = np.flatnonzero(keep)
    if idx.size == 0:
        raise ValueError("Sampling mask does not overlap the connectome brain mask.")
    return idx


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


def harvard_oxford(ref_img):
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


def yeo7(ref_img):
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
    """Region breakdown of a (already thresholded/filtered) map's pos/neg tails.
    Rows are (name, voxels, pct, mean_stat) tuples."""
    timg = _as_img(vmap_img)
    t = np.asarray(timg.get_fdata())
    pos, neg = t >= tc, t <= -tc
    tables = {"n_pos": int(pos.sum()), "n_neg": int(neg.sum())}
    if not use_atlases:
        return tables
    for loader, key in ((harvard_oxford, "ho"), (yeo7, "yeo")):
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


def static_png(net_img, tc, title, lesion_path=None):
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


def mosaic_png(net_img, tc, lesion_path=None, dpi=145):
    """Light multi-slice mosaic (all three planes) -- fallback if the viewer fails."""
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


def interactive_html(net_img, tc, lesion_path=None):
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
        f"<tr><td>{nm}</td><td>{n}</td><td>{pct:.3f}%</td><td>{mt:+.3f}</td></tr>"
        for nm, n, pct, mt in rows)
    return (f"<h3>{title}</h3><table><thead><tr>{head}</tr></thead>"
            f"<tbody>{body}</tbody></table>")


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

    # supporting panel: interactive viewer (static section image as fallback)
    if imgs.get("support_iframe"):
        support_view = (f'<div class="viewer">{imgs["support_iframe"]}</div>'
                        '<p class="hint">Thresholded network before the specificity filter '
                        '&mdash; scroll to move through slices, drag to reposition.</p>')
    elif imgs.get("support"):
        support_view = (f'<div class="viewer"><img src="data:image/png;base64,'
                        f'{imgs["support"]}"></div>'
                        '<p class="hint">Thresholded network before the specificity filter '
                        '(static section view).</p>')
    else:
        support_view = (f"<p class='muted'>Figure unavailable: "
                        f"{imgs.get('support_err', imgs.get('support_iframe_err', 'n/a'))}</p>")

    ra = summary["r_after_str"]
    stat_cards = f"""<div class="grid">
<div class="stat"><div class="l">Lesion volume</div><div class="v">{summary['lesion_voxels']} <small>vox</small></div></div>
<div class="stat"><div class="l">Threshold</div><div class="v">|{mlabel}| &ge; {round(summary['tc'], 3)}</div></div>
<div class="stat"><div class="l">Supra-threshold</div><div class="v">{summary['n_pos_thr']}<small> pos</small> / {summary['n_neg_thr']}<small> neg</small></div></div>
{'<div class="stat"><div class="l">Specificity survivors</div><div class="v">'+str(spec['n_sig_pos'])+'<small> pos</small> / '+str(spec['n_sig_neg'])+'<small> neg</small></div></div>' if spec else ''}
<div class="stat"><div class="l">Degree r (before&rarr;after)</div><div class="v">{summary['r_before']:.3f}<small> &rarr; {ra}</small></div></div>
<div class="stat"><div class="l">Connectome</div><div class="v">{summary['N']}<small> subj, D={summary['D']}</small></div></div>
</div>"""

    methods = f"""<div class="methods"><b>Methods.</b> The lesion was used as a seed
in the HCP&nbsp;S1200 normative connectome (N={summary['N']}, {summary['D']}-component
low-rank model). Its connectivity to every brain voxel was computed per subject and
Fisher-z transformed, summarised as a {stat_name}, and {adj} by regressing out the
connectome's correlation degree. The map was restricted to the MNI152 brain and
thresholded at |{mlabel}|&nbsp;&ge;&nbsp;{round(summary['tc'], 3)}{summary['thr_note']}. A
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
{support_view}
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

<footer>Generated by NeuroVue DA-LNM &middot; maps in MNI152 2&nbsp;mm space</footer>
</div></body></html>"""
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)
    return out_html
