import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Brain, LayoutGrid, Box, Camera, Crosshair as CrosshairIcon, Activity, Scissors,
  Eye, Layers, FlaskConical, PencilRuler, Database, Plus, Image as ImageIcon, Waypoints, Trash2,
  RotateCcw, Columns3, BadgeCheck, Ruler, AlertTriangle, Save, FolderOpen,
  GitCompareArrows, GitBranch, ZoomIn, Loader2, AlertCircle, X, Target, Network, Download,
} from "lucide-react";
import NiivueViewer from "@/components/NiivueViewer";
import SplashScreen from "@/components/SplashScreen";
import LayerControl from "@/components/LayerControl";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";
import ColorBarStack from "@/components/ColorBarStack";
import FileUploader from "@/components/FileUploader";
import AtlasValidationPanel from "@/components/AtlasValidationPanel";
import { PolarAngleDisc, EccentricityBar, polarAngleDiscToDataURL } from "@/components/PolarAngleDisc";
import { SidebarSection } from "@/components/SidebarSection";
import { CrosshairInfo } from "@/components/CrosshairInfo";
import { DrawingPanel } from "@/components/DrawingPanel";
import { MeasurePanel } from "@/components/MeasurePanel";
import { LongitudinalPanel } from "@/components/LongitudinalPanel";
import { ClusterPanel } from "@/components/ClusterPanel";
import { OverlapPanel } from "@/components/OverlapPanel";
import { LesionReportPanel } from "@/components/LesionReportPanel";
import { OneClickSummaryPanel } from "@/components/OneClickSummaryPanel";
import { TractDissectionPanel } from "@/components/TractDissectionPanel";
import { DaLnMapperPanel } from "@/components/DaLnMapperPanel";
import { AddROIPanel } from "@/components/AddROIPanel";
import { Slider } from "@/components/ui/slider";
import {
  BASE_VOLUME, RETINOTOPY_LAYERS, WHITE_MATTER_RETINOTOPY_LAYERS,
  STANDARD_ATLASES, WANG_LABELS, VAREA_LABELS,
} from "@/lib/atlasConfig";
// Cortical (Benson) + white-matter (template) layers share the same
// toggle/load/colorbar plumbing. The WM .nii.gz files are produced offline and
// may be absent — toggling one surfaces a "failed to load" toast (graceful), and
// the legend stays empty until installed.
const ALL_RETINOTOPY_LAYERS = [
  ...RETINOTOPY_LAYERS,
  ...WHITE_MATTER_RETINOTOPY_LAYERS,
];
import { VISFATLAS_NAV_MM } from "@/lib/visfAtlasColormap";
import { nearestEloquentAtMM } from "@/lib/eloquent";
import {
  computeVoxelCounts, unionCounts, affectedSet, mergeRanges,
  classifyHemifield, buildSummary,
  computeVoxelCounts2D, unionGrids,
} from "@/lib/retinotopyAnalysis";
import { VisualFieldMap2D, visualFieldMap2DToDataURL, visualFieldMap2DDataURL } from "@/components/VisualFieldMap2D";
import { convertDicom, fetchDicomSeriesFile, dicomSeriesDownloadUrl } from "@/lib/dicom";
import { tractSubsampleAvailable, subsampleTract } from "@/lib/tractography";
import {
  WORKSPACE_VERSION, fileToBase64, base64ToFile, saveWorkspace, openWorkspace,
} from "@/lib/workspace";
import { toast } from "sonner";

const SLICE_MODES = [
  { id: "multiplanar", label: "Multiplanar + 3D", icon: LayoutGrid },
  { id: "render", label: "3D Render", icon: Box },
  { id: "axial", label: "Axial", icon: Activity },
  { id: "coronal", label: "Coronal", icon: Activity },
  { id: "sagittal", label: "Sagittal", icon: Activity },
];

const LESION_CMAP = "red";
const ROI_CMAP_PALETTE = ["green", "blue", "winter", "plasma", "viridis", "warm"];
const ACTIVATION_CMAP_PALETTE = ["warm", "cool", "plasma", "viridis", "inferno", "hot", "actc", "winter"];
const TRACT_RGB_PALETTE = [
  [255, 165, 0, 255],
  [120, 200, 255, 255],
  [180, 80, 255, 255],
  [80, 230, 180, 255],
  [255, 90, 140, 255],
];

const MESH_EXTS = [".trk", ".tck", ".trx", ".vtk", ".gii", ".mz3", ".obj", ".stl", ".ply"];
// NiiVue parses tractograms entirely in the WebGL renderer (one contiguous
// ArrayBuffer + several typed-array copies), so files past this size reliably
// exhaust the renderer's memory. Larger files are decimated on the backend.
const TRACT_CLIENT_MAX_BYTES = 700 * 1024 * 1024; // ~700 MB

export default function Dashboard() {
  const viewerRef = useRef(null);
  const bensonVfMap2dRef = useRef(null);
  const wmVfMap2dRef = useRef(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [sliceType, setSliceType] = useState("multiplanar");
  const [crosshair, setCrosshair] = useState(true);
  const [crosshairWidth, setCrosshairWidth] = useState(1);
  const [crosshairColor, setCrosshairColor] = useState("white");
  const [showCrosshairSettings, setShowCrosshairSettings] = useState(false);
  const [clipDepth, setClipDepth] = useState(2);
  const [clipAz, setClipAz] = useState(0);
  const [clipEl, setClipEl] = useState(0);
  const [baseLabel, setBaseLabel] = useState(BASE_VOLUME.name);
  const [baseVisible, setBaseVisible] = useState(true);
  // DICOM import: series picker + staged progress (upload → convert → load).
  const [dicomJob, setDicomJob] = useState(null);       // { jobId, series }
  const [loadedSeriesId, setLoadedSeriesId] = useState(null); // highlights the loaded series row
  const [dicomProgress, setDicomProgress] = useState(null); // { stage, fraction }
  const [dicomDownload, setDicomDownload] = useState(null); // { jobId, seriesId, name } of the loaded series
  const [baseOpacity, setBaseOpacity] = useState(1.0);
  const [baseColormap, setBaseColormap] = useState("gray");
  const [baseColorbarOn, setBaseColorbarOn] = useState(false);
  const [baseOverlayMeta, setBaseOverlayMeta] = useState({});

  // Asymmetric layout (1 large + 3 small side views). When asymmetric=true,
  // `largeSlice` is the slice key currently in the big slot. Double-clicking
  // a side view swaps it into the big slot.
  const [asymmetric, setAsymmetric] = useState(false);
  const [largeSlice, setLargeSlice] = useState("axial");

  // Overlay metadata cache: id → {globalMin, globalMax, calMin, calMax, isSigned, ignoreZeroVoxels}
  // Populated whenever an overlay is loaded / its thresholds change. Used to drive
  // the per-layer threshold UI and the ColorBarStack on the viewer.
  const [overlayMeta, setOverlayMeta] = useState({});

  // Short label for whichever slider scroll is currently bound to ('Depth', 'Base', 'Az', …).
  const [scrollTarget, setScrollTarget] = useState(null);
  // Stores a (delta: number) => void function that adjusts whichever slider
  // was last interacted with. delta is +1 (scroll up) or -1 (scroll down).
  // Plain scroll fires this (if set). Ctrl+scroll always zooms via NiiVue.
  const scrollAdjustRef = useRef(null);
  // Ref attached to the canvas wrapper div for the non-passive wheel listener.
  const canvasWrapperRef = useRef(null);

  // Atlas verification modal (Benson/Wang side-by-side surface↔volume plots)
  const [showValidation, setShowValidation] = useState(false);

  // Per-activation-layer atlas selection for region-name lookups in the
  // crosshair info bar. Map: layerId → atlasId (one of STANDARD_ATLASES.id).
  const [layerLabelAtlas, setLayerLabelAtlas] = useState({});

  // Retinotopy overlay state
  const initRetState = useMemo(() => {
    const s = {};
    for (const l of ALL_RETINOTOPY_LAYERS) s[l.id] = { visible: false, opacity: l.opacity, colormap: l.colormap };
    return s;
  }, []);
  const [retState, setRetState] = useState(initRetState);

  // Lesion-aware retinotopy legend state. selectedLesionIds drives both the
  // polar wheel and eccentricity bar (one picker, two legends). Each legend
  // has its own threshold mode ("any" | "min") + min-voxel count. retAtlasTick
  // bumps whenever a retinotopy atlas (re)loads so the analysis useMemos
  // re-read viewerRef.current.getVolume — refs aren't reactive on their own.
  const [selectedLesionIds, setSelectedLesionIds] = useState(() => new Set());
  const [polarThresh, setPolarThresh] = useState({ mode: "any", min: 3 });
  const [eccenThresh, setEccenThresh] = useState({ mode: "any", min: 3 });
  const [eccenInverted, setEccenInverted] = useState(false);
  const [retAtlasTick, setRetAtlasTick] = useState(0);
  const [lesionPickerOpen, setLesionPickerOpen] = useState(false);
  const [bensonViewMode, setBensonViewMode] = useState("2d");
  const [wmInlineViewMode, setWmInlineViewMode] = useState("2d");

  // Standard atlas state (AAL, HO, Juelich)
  const initAtlasState = useMemo(() => {
    const s = {};
    for (const a of STANDARD_ATLASES) s[a.id] = { visible: false, opacity: a.opacity, colormap: a.colormap };
    return s;
  }, []);
  const [atlasState, setAtlasState] = useState(initAtlasState);
  // labels caches: atlasId -> { value: name }
  const atlasLabelsRef = useRef({});
  // Live snapshot of atlasState for use inside handleLocationChange without
  // adding atlasState to the callback's dependency array.
  const atlasStateRef = useRef(atlasState);
  useEffect(() => { atlasStateRef.current = atlasState; }, [atlasState]);

  // User-uploaded layers (lesion / roi / activation / custom-atlas)
  const [userLayers, setUserLayers] = useState([]);
  const userFileCache = useRef({});

  // Tract / mesh layers
  const [tractLayers, setTractLayers] = useState([]);
  const tractDirectionMap = useRef({});
  const [tractLoading, setTractLoading] = useState(null);   // { name, phase } | null
  const [tractLoadError, setTractLoadError] = useState(null); // { name, message } | null

  // Crosshair tracking
  const [crosshairMM, setCrosshairMM] = useState(null);
  const [crosshairVox, setCrosshairVox] = useState(null);
  const [crosshairLabels, setCrosshairLabels] = useState({});
  // List of {layerName, value} for all visible volumes at the current voxel
  const [crosshairValues, setCrosshairValues] = useState([]);

  // Eloquent-structure proximity (Jülich). Off by default — enabling it
  // auto-loads the Jülich atlas (invisible) for distance lookups.
  const [proximityWarn, setProximityWarn] = useState(false);
  const [crosshairEloquent, setCrosshairEloquent] = useState(null);
  const proximityWarnRef = useRef(false);
  const lastEloquentMM = useRef(null);
  const labelsDebounceRef = useRef(null);

  // ===== Location change → labels + voxel values =====
  const handleLocationChange = useCallback((data) => {
    if (!data) return;
    if (data.mm) setCrosshairMM([data.mm[0], data.mm[1], data.mm[2]]);
    if (data.vox) setCrosshairVox([data.vox[0], data.vox[1], data.vox[2]]);

    // Eloquent proximity (throttled: skip if crosshair moved < 0.5mm).
    if (proximityWarnRef.current && data.mm) {
      const prev = lastEloquentMM.current;
      const moved =
        !prev ||
        Math.abs(prev[0] - data.mm[0]) +
          Math.abs(prev[1] - data.mm[1]) +
          Math.abs(prev[2] - data.mm[2]) > 0.5;
      if (moved) {
        lastEloquentMM.current = [data.mm[0], data.mm[1], data.mm[2]];
        const jvol = viewerRef.current?.getVolume?.("juelich");
        const jlabels = atlasLabelsRef.current?.juelich;
        if (jvol?.img && jlabels) {
          setCrosshairEloquent(
            nearestEloquentAtMM([data.mm[0], data.mm[1], data.mm[2]], jvol, jlabels, 6)
          );
        }
      }
    }
    // niivue reports each volume's name as the URL basename (e.g.
    // 'visfAtlas_maxprob'). Map that back to the layer id we registered.
    const canon = (rawName) => {
      if (!rawName) return rawName;
      if (rawName.includes("visfAtlas")) return "visfAtlas";
      if (rawName.includes("wang2015_maxprob")) return "wang2015_maxprob";
      if (rawName.includes("benson14_polar_angle")) return "benson_polar_angle";
      if (rawName.includes("benson14_eccentricity")) return "benson_eccentricity";
      if (rawName.includes("benson14_visual_areas")) return "benson_visual_areas";
      const m = rawName.match(/^(aal|harvard_oxford_[a-z]+|juelich|destrieux)(_atlas)?$/);
      if (m) return m[1];
      return rawName;
    };
    const labels = {};
    const values = data.values || [];
    const valueRows = [];
    for (const v of values) {
      const name = canon(v.name);
      const k = Math.round(v.value);
      if (k > 0) {
        if (name === "wang2015_maxprob" && WANG_LABELS[k]) labels["Wang ROI"] = WANG_LABELS[k];
        else if (name === "benson_visual_areas" && VAREA_LABELS[k]) labels["Visual Area"] = VAREA_LABELS[k];
        else if (atlasLabelsRef.current[name]) {
          // Jülich is loaded silently for the Eloquent Warn feature. Only show
          // its region labels when warn is active OR when the user has explicitly
          // enabled the Jülich atlas in the Atlases panel.
          const juelichGated = name === "juelich"
            && !proximityWarnRef.current
            && !atlasStateRef.current.juelich?.visible;
          if (!juelichGated) {
            const tbl = atlasLabelsRef.current[name];
            if (tbl[k]) labels[shortAtlas(name)] = tbl[k];
          }
        }
      }
      // Build a numeric value row for *every* loaded volume. Hidden-label
      // helpers (suffix "__labels") are skipped. Same Jülich gate applies
      // so "JÜLICH 36.00" doesn't appear when warn is off.
      if (typeof v.value === "number" && !String(name || "").endsWith("__labels")) {
        const juelichGated = name === "juelich"
          && !proximityWarnRef.current
          && !atlasStateRef.current.juelich?.visible;
        if (!juelichGated) {
          valueRows.push({ name: shortLayerName(name), value: v.value });
        }
      }
    }
    // For each user layer with a chosen label atlas, look up the region
    // name from THAT atlas at the current voxel and surface it as
    // `LayerShort → AtlasShort` : "Region name" in the labels bar.
    const extra = {};
    for (const [layerId, atlasId] of Object.entries(layerLabelAtlas)) {
      if (!atlasId) continue;
      const v = values.find((x) => canon(x.name) === atlasId);
      if (!v) continue;
      const k = Math.round(v.value);
      if (k <= 0) continue;
      const tbl = atlasLabelsRef.current[atlasId];
      if (tbl?.[k]) {
        extra[`${shortLayerName(layerId)}↦${shortAtlas(atlasId)}`] = tbl[k];
      }
    }
    const mergedLabels = Object.keys(extra).length ? { ...labels, ...extra } : labels;

    // Debounce label and value updates (40ms) to prevent flicker when scrolling
    // rapidly between named and unnamed atlas regions. Position updates (mm/vox)
    // remain immediate so the coordinate display stays responsive.
    clearTimeout(labelsDebounceRef.current);
    labelsDebounceRef.current = setTimeout(() => {
      setCrosshairLabels(mergedLabels);
      setCrosshairValues(valueRows);
    }, 40);
  }, [layerLabelAtlas]);

  // Atlas lookup function for cluster table (returns region name at a peak voxel)
  const atlasLabelLookup = useCallback((peakVox) => {
    const nv = viewerRef.current?.getNiivue();
    if (!nv) return null;
    // pick first visible standard atlas
    for (const a of STANDARD_ATLASES) {
      if (!atlasState[a.id]?.visible) continue;
      const vol = nv.volumes.find((v) => v?.name === a.id);
      if (!vol?.img || !vol?.dims) continue;
      const [, nx, ny] = vol.dims;
      const [i, j, k] = peakVox.map((n) => Math.round(n));
      const idx = i + nx * (j + ny * k);
      const val = Math.round(vol.img[idx] || 0);
      const labels = atlasLabelsRef.current[a.id];
      if (labels?.[val]) return `${shortAtlas(a.id)}: ${labels[val]}`;
    }
    return null;
  }, [atlasState]);

  // ===== Retinotopy handlers =====
  const handleRetToggle = async (id) => {
    const cfg = ALL_RETINOTOPY_LAYERS.find((l) => l.id === id);
    const s = retState[id];
    const viewer = viewerRef.current;
    if (!cfg || !viewer) return;
    if (s.visible) {
      viewer.removeOverlayByName(id);
      if (cfg.labelLayerId) viewer.removeHiddenLabelLayer(cfg.labelLayerId);
      setRetState((p) => ({ ...p, [id]: { ...p[id], visible: false } }));
    } else {
      const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: s.opacity, colormap: s.colormap });
      if (vol) {
        if (cfg.labelLayerId && cfg.labelLayerUrl) {
          await viewer.addHiddenLabelLayer(cfg.labelLayerId, cfg.labelLayerUrl);
        }
        setRetState((p) => ({ ...p, [id]: { ...p[id], visible: true } }));
        refreshOverlayMeta(id);
        toast.success(`${cfg.name} loaded`);
      }
    }
  };
  const handleRetOpacity = (id, v) => {
    setRetState((p) => ({ ...p, [id]: { ...p[id], opacity: v } }));
    viewerRef.current?.setOverlayOpacity(id, v);
    setScrollTarget('Ret');
    scrollAdjustRef.current = (d) => setRetState((p) => {
      const cur = p[id]?.opacity ?? 1;
      const n = Math.max(0, Math.min(1, cur + d * 0.05));
      viewerRef.current?.setOverlayOpacity(id, n);
      return { ...p, [id]: { ...p[id], opacity: n } };
    });
  };
  const handleRetColormap = (id, cm) => {
    setRetState((p) => ({ ...p, [id]: { ...p[id], colormap: cm } }));
    viewerRef.current?.setOverlayColormap(id, cm);
  };

  // ===== Standard atlases handlers =====
  const loadAtlasLabels = async (id, labelsUrl) => {
    if (!labelsUrl || atlasLabelsRef.current[id]) return;
    try {
      const res = await fetch(labelsUrl);
      const data = await res.json();
      const tbl = {};
      if (Array.isArray(data)) {
        // AAL / HO / Destrieux: array of {index, name}
        for (const it of data) tbl[it.index] = it.name;
      } else if (data && typeof data === "object") {
        // visfAtlas: dict {"1":"lh_mFus_faces", ...}
        for (const [k, v] of Object.entries(data)) {
          tbl[parseInt(k, 10)] = v;
        }
      }
      atlasLabelsRef.current[id] = tbl;
    } catch (e) {
      console.warn("labels fetch failed:", e);
    }
  };

  const handleAtlasToggle = async (id) => {
    const cfg = STANDARD_ATLASES.find((a) => a.id === id);
    const s = atlasState[id];
    const viewer = viewerRef.current;
    if (!cfg || !viewer) return;
    if (s.visible) {
      viewer.removeOverlayByName(id);
      setAtlasState((p) => ({ ...p, [id]: { ...p[id], visible: false } }));
    } else {
      const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: s.opacity, colormap: s.colormap });
      if (vol) {
        await loadAtlasLabels(id, cfg.labelsUrl);
        setAtlasState((p) => ({ ...p, [id]: { ...p[id], visible: true } }));
        refreshOverlayMeta(id);
        toast.success(`${cfg.name} loaded`);
        // visfAtlas ROIs sit on higher visual cortex (ventral occipital-temporal
        // and lateral occipital). Default crosshair at brain centre never
        // intersects them — auto-jump so the user can immediately see colour.
        if (id === "visfAtlas" && VISFATLAS_NAV_MM) {
          viewer.setCrosshairMM?.(...VISFATLAS_NAV_MM);
        }
      }
    }
  };
  const handleAtlasOpacity = (id, v) => {
    setAtlasState((p) => ({ ...p, [id]: { ...p[id], opacity: v } }));
    viewerRef.current?.setOverlayOpacity(id, v);
    setScrollTarget('Atlas');
    scrollAdjustRef.current = (d) => setAtlasState((p) => {
      const cur = p[id]?.opacity ?? 1;
      const n = Math.max(0, Math.min(1, cur + d * 0.05));
      viewerRef.current?.setOverlayOpacity(id, n);
      return { ...p, [id]: { ...p[id], opacity: n } };
    });
  };
  const handleAtlasColormap = (id, cm) => {
    setAtlasState((p) => ({ ...p, [id]: { ...p[id], colormap: cm } }));
    viewerRef.current?.setOverlayColormap(id, cm);
  };

  // ===== Generic user-uploaded layer add (volume) =====
  const addUserFile = async (file, type, opts = {}) => {
    const viewer = viewerRef.current;
    if (!viewer) return null;
    const id = `${type}-${Date.now()}`;
    const cm =
      opts.colormap ||
      (type === "lesion" ? LESION_CMAP
        : type === "activation" ? ACTIVATION_CMAP_PALETTE[userLayers.filter((l) => l.type === "activation").length % ACTIVATION_CMAP_PALETTE.length]
        : type === "atlas" ? "random"
        : ROI_CMAP_PALETTE[userLayers.filter((l) => l.type === "roi").length % ROI_CMAP_PALETTE.length]);
    const opacity = opts.opacity ?? (type === "lesion" ? 0.85 : 0.8);
    const vol = await viewer.addOverlayFromFile(file, { colormap: cm, opacity, name: id });
    if (!vol) return null;
    userFileCache.current[id] = { file, colormap: cm };
    // Activation maps omit the type prefix — the section header already says "Activation Maps"
    const layerName = type === "activation" ? file.name : `${typeLabel(type)} · ${file.name}`;
    setUserLayers((p) => [
      ...p,
      { id, name: opts.name || layerName, type, visible: true, opacity, colormap: cm,
        description: `${(file.size / 1024).toFixed(1)} KB` },
    ]);
    refreshOverlayMeta(id);
    toast.success(`${typeLabel(type)} loaded`, { description: file.name });
    return vol;
  };

  const handleUserToggle = (id) => {
    const layer = userLayers.find((l) => l.id === id);
    const viewer = viewerRef.current;
    if (!layer || !viewer) return;
    if (layer.visible) {
      // Zero the opacity rather than removing the volume. This preserves all
      // runtime state on the NiiVue NVImage object: __zeroMaskCache,
      // __origColormap, __userThreshold, __invertThreshold, and the derived
      // __thr_* LUT registration. Removing and re-adding (the old approach)
      // created a fresh NVImage and silently wiped mask-zero and threshold
      // state. The volume is only truly removed on explicit user "remove" via
      // handleUserRemove.
      viewer.setOverlayOpacity(id, 0);
      setUserLayers((p) => p.map((l) => (l.id === id ? { ...l, visible: false } : l)));
    } else {
      // Restore the saved opacity. No refreshOverlayMeta needed — vol state was
      // never destroyed so overlayMeta is already up to date.
      viewer.setOverlayOpacity(id, layer.opacity);
      setUserLayers((p) => p.map((l) => (l.id === id ? { ...l, visible: true } : l)));
    }
  };
  const handleUserOpacity = (id, v) => {
    setUserLayers((p) => p.map((l) => (l.id === id ? { ...l, opacity: v } : l)));
    viewerRef.current?.setOverlayOpacity(id, v);
    const layerLabel = userLayers.find((l) => l.id === id)?.name?.slice(0, 12) ?? 'Layer';
    setScrollTarget(layerLabel);
    scrollAdjustRef.current = (d) => setUserLayers((p) => {
      const layer = p.find((l) => l.id === id);
      if (!layer) return p;
      const n = Math.max(0, Math.min(1, layer.opacity + d * 0.05));
      viewerRef.current?.setOverlayOpacity(id, n);
      return p.map((l) => (l.id === id ? { ...l, opacity: n } : l));
    });
  };
  const handleUserColormap = (id, cm) => {
    setUserLayers((p) => p.map((l) => (l.id === id ? { ...l, colormap: cm } : l)));
    viewerRef.current?.setOverlayColormap(id, cm);
  };
  const handleUserRemove = (id) => {
    viewerRef.current?.removeOverlayByName(id);
    delete userFileCache.current[id];
    setUserLayers((p) => p.filter((l) => l.id !== id));
    setOverlayMeta((p) => {
      const n = { ...p };
      delete n[id];
      return n;
    });
  };

  // ===== Overlay threshold / mask-zero handling =====
  // Pulls the volume's data range from niivue after a load so the
  // dual-threshold slider knows globalMin / globalMax. Called for every
  // overlay we add (retinotopy, standard atlas, user upload, custom atlas).
  const refreshOverlayMeta = useCallback((id) => {
    // Wait a tick for niivue to compute global_min/max after volume load.
    setTimeout(() => {
      const info = viewerRef.current?.getOverlayInfo(id);
      // Merge rather than replace: optimistic flags set by handleIgnoreZeroChange
      // and handleInvertThresholdChange must survive the async refresh, and
      // getOverlayInfo now correctly returns those flags anyway.
      if (info) setOverlayMeta((p) => ({ ...p, [id]: { ...(p[id] || {}), ...info } }));
    }, 60);
  }, []);

  const handleCalRangeChange = (id, cal_min, cal_max) => {
    viewerRef.current?.setOverlayCalRange(id, cal_min, cal_max);
    setOverlayMeta((p) => ({
      ...p,
      [id]: { ...(p[id] || {}), cal_min, cal_max },
    }));
  };
  const handleIgnoreZeroChange = (id, on) => {
    viewerRef.current?.setIgnoreZeroVoxels(id, on);
    setOverlayMeta((p) => ({
      ...p,
      [id]: { ...(p[id] || {}), ignoreZeroVoxels: on },
    }));
    // No refreshOverlayMeta: mask-zero no longer mutates cal_min/cal_max,
    // so the async re-read has nothing to sync and would only introduce jitter.
  };
  const handleInvertThresholdChange = (id, on) => {
    viewerRef.current?.setOverlayInvertThreshold(id, on);
    setOverlayMeta((p) => ({
      ...p,
      [id]: { ...(p[id] || {}), invertThreshold: on },
    }));
    // getOverlayInfo returns vol.__userThreshold values, which are stable
    // across invert toggles (the threshold range itself doesn't change —
    // only the alpha mask direction does). No refresh needed in either
    // direction.
  };

  const handleEccenInvert = useCallback(() => {
    setEccenInverted((prev) => {
      const next = !prev;
      viewerRef.current?.setColormapInverted?.("benson_eccentricity", next);
      return next;
    });
  }, []);

  // Ensure a standard atlas is loaded as a queryable niivue volume + its
  // labels are fetched. If not already present, loads it invisibly
  // (opacity 0) so it can be sampled without visually clashing. Returns the
  // atlas NVImage, or null. Shared by the label-atlas picker, the lesion
  // report, and the eloquent-proximity warning.
  const ensureAtlasLoaded = useCallback(async (atlasId, { silent = false } = {}) => {
    if (!atlasId) return null;
    const viewer = viewerRef.current;
    const nv = viewer?.getNiivue();
    if (!viewer || !nv) return null;
    const cfg = STANDARD_ATLASES.find((a) => a.id === atlasId);
    if (!cfg) return null;
    const existing = nv.volumes?.find((v) => v?.name === atlasId);
    if (existing) {
      if (cfg.labelsUrl) await loadAtlasLabels(atlasId, cfg.labelsUrl);
      return existing;
    }
    const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: 0 });
    if (vol) {
      await loadAtlasLabels(atlasId, cfg.labelsUrl);
      setAtlasState((p) => ({ ...p, [atlasId]: { ...p[atlasId], visible: false, opacity: 0 } }));
      if (!silent) toast.success(`${cfg.short} loaded for label lookup`);
    }
    return vol;
  }, []);

  // Same pattern as ensureAtlasLoaded but for RETINOTOPY_LAYERS. Used by the
  // lesion-aware retinotopy legend so polar/eccen atlases can be sampled even
  // when the user hasn't toggled them on in the 3D view.
  const ensureRetinotopyLoaded = useCallback(async (layerId, { silent = false } = {}) => {
    if (!layerId) return null;
    const viewer = viewerRef.current;
    const nv = viewer?.getNiivue();
    if (!viewer || !nv) return null;
    const cfg = ALL_RETINOTOPY_LAYERS.find((l) => l.id === layerId);
    if (!cfg) return null;
    const existing = nv.volumes?.find((v) => v?.name === layerId);
    if (existing) return existing;
    const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: 0 });
    if (vol) {
      setRetState((p) => ({ ...p, [layerId]: { ...p[layerId], visible: false, opacity: 0 } }));
      setRetAtlasTick((t) => t + 1);
      if (!silent) toast.success(`${cfg.name} loaded for overlap lookup`);
    }
    return vol;
  }, []);

  // Set a label-atlas for an activation layer. Auto-loads the chosen atlas
  // (invisible) if needed so the niivue volume is queryable at the crosshair.
  const handleLayerLabelAtlasChange = async (layerId, atlasId) => {
    setLayerLabelAtlas((p) => ({ ...p, [layerId]: atlasId || null }));
    if (!atlasId) return;
    await ensureAtlasLoaded(atlasId);
  };

  // ===== Base volume upload / reset =====
  const handleBaseUpload = async (file) => {
    const ok = await viewerRef.current?.replaceBaseVolume(file);
    if (ok) {
      setBaseLabel(file.name);
      setDicomDownload(null);
      refreshBaseOverlayMeta();
    }
  };

  const handleDicomImport = async (fileArr) => {
    if (!fileArr?.length) return;
    setDicomJob(null);
    setDicomDownload(null);
    setDicomProgress({ stage: "upload", fraction: 0 });
    try {
      const res = await convertDicom(fileArr, (f) =>
        setDicomProgress({ stage: "upload", fraction: f }),
      );
      // Upload done — dcm2niix runs server-side (indeterminate).
      setDicomProgress({ stage: "convert", fraction: 1 });
      const series = res?.series || [];
      if (series.length === 0) {
        setDicomProgress(null);
        toast.error("No series produced from these DICOM files.");
        return;
      }
      setDicomProgress(null);
      if (series.length === 1) {
        // Only one series — load it straight away.
        await loadDicomSeries(res.job_id, series[0]);
      } else {
        setLoadedSeriesId(null);
        setDicomJob({ jobId: res.job_id, series });
        toast.info(`${series.length} series found`, { description: "Pick one to load." });
      }
    } catch (e) {
      setDicomProgress(null);
      toast.error("DICOM import failed", { description: e?.message });
    }
  };

  const loadDicomSeries = async (jobId, s) => {
    setDicomProgress({ stage: "load", fraction: 1 });
    try {
      const niftiFile = await fetchDicomSeriesFile(jobId, s.id);
      const ok = await viewerRef.current?.replaceBaseVolume(niftiFile);
      if (ok) {
        setBaseLabel(`DICOM · ${s.description || s.id}`);
        setLoadedSeriesId(s.id);
        setDicomDownload({ jobId, seriesId: s.id, name: s.description || s.id });
        refreshBaseOverlayMeta();
      }
      // Keep the series picker open so the user can load another series from the
      // same study (jobId stays valid server-side). The Cancel button dismisses it.
      toast.success("DICOM series loaded", { description: s.description || s.id });
    } catch (e) {
      toast.error("Failed to load series", { description: e?.message });
    } finally {
      setDicomProgress(null);
    }
  };

  const handleResetBase = async () => {
    const ok = await viewerRef.current?.resetToBase(BASE_VOLUME);
    if (ok) {
      setBaseLabel(BASE_VOLUME.name);
      setBaseVisible(true);
      setDicomDownload(null);
      toast.success("MNI152 template restored");
    }
  };

  const handleBaseVisibilityToggle = () => {
    const next = !baseVisible;
    setBaseVisible(next);
    viewerRef.current?.setBaseVisible(next);
  };
  const handleBaseOpacity = (_, v) => {
    setBaseOpacity(v);
    viewerRef.current?.setBaseOpacity(v);
    setScrollTarget('Base');
    scrollAdjustRef.current = (d) => setBaseOpacity((p) => {
      const n = Math.max(0, Math.min(1, p + d * 0.05));
      viewerRef.current?.setBaseOpacity(n);
      return n;
    });
  };
  const handleBaseColormap = (_, cm) => {
    setBaseColormap(cm);
    viewerRef.current?.setBaseColormap(cm);
  };
  const handleBaseCalRange = (_, lo, hi) => {
    viewerRef.current?.setBaseWindow(lo, hi);
    setBaseOverlayMeta((p) => ({ ...p, cal_min: lo, cal_max: hi }));
  };
  const handleBaseColorbarToggle = (_, on) => {
    setBaseColorbarOn(on);
    viewerRef.current?.setBaseColorbarVisible(on);
  };
  const refreshBaseOverlayMeta = useCallback(() => {
    setTimeout(() => {
      const range = viewerRef.current?.getBaseRange();
      if (range) setBaseOverlayMeta(range);
    }, 60);
  }, []);

  // ===== Tract files (.trk/.tck/.trx) =====
  const handleTractUpload = async (file) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const lower = file.name.toLowerCase();
    if (!MESH_EXTS.some((ext) => lower.endsWith(ext))) {
      return toast.error("Unsupported tract format", { description: "Use .trk, .tck, .trx, .vtk, .gii, .mz3" });
    }
    const id = `tract-${Date.now()}`;
    const rgba = TRACT_RGB_PALETTE[tractLayers.length % TRACT_RGB_PALETTE.length];
    const colorByDirection = lower.endsWith(".trk") || lower.endsWith(".tck") || lower.endsWith(".trx");
    setTractLoading({ name: file.name, phase: "Reading file…" });
    setTractLoadError(null);
    try {
      // Files too large for the in-browser parser are decimated server-side
      // first; the smaller result is what actually gets rendered.
      let fileToLoad = file;
      let subsampled = false;
      if (file.size > TRACT_CLIENT_MAX_BYTES) {
        setTractLoading({ name: file.name, phase: "Checking server…" });
        if (!(await tractSubsampleAvailable())) {
          setTractLoadError({
            name: file.name,
            message:
              "File too large to render in-browser and the backend is not running. Start the backend (uvicorn) or use a smaller tractogram.",
          });
          return;
        }
        setTractLoading({ name: file.name, phase: "Subsampling on server…" });
        try {
          fileToLoad = await subsampleTract(file);
          subsampled = true;
        } catch (e) {
          setTractLoadError({ name: file.name, message: e?.message || "Server subsampling failed" });
          return;
        }
      }
      const mesh = await viewer.addMeshFromFile(fileToLoad, {
        rgba255: rgba, opacity: 1.0, name: id, colorByDirection,
        onProgress: (phase) => setTractLoading({ name: file.name, phase }),
        onError: (message) => setTractLoadError({ name: file.name, message }),
      });
      if (mesh) {
        tractDirectionMap.current[id] = colorByDirection;
        const sizeLabel = `${(file.size / 1024).toFixed(1)} KB`;
        setTractLayers((p) => [
          ...p,
          { id, name: `Tract · ${file.name}`, visible: true, opacity: 1.0,
            color: `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`,
            direction: colorByDirection,
            description: subsampled ? `${sizeLabel} · subsampled` : sizeLabel },
        ]);
        toast.success("Tract loaded", { description: file.name });
      }
    } finally {
      setTractLoading(null);
    }
  };
  const handleTractDirectionToggle = (id, next) => {
    setTractLayers((p) => p.map((l) => (l.id === id ? { ...l, direction: next } : l)));
    viewerRef.current?.setMeshFiberColor(id, next ? "Local" : "Global");
  };
  const handleTractOpacity = (id, v) => {
    setTractLayers((p) => p.map((l) => (l.id === id ? { ...l, opacity: v } : l)));
    viewerRef.current?.setMeshOpacity(id, v);
  };
  const handleTractRemove = (id) => {
    viewerRef.current?.removeMesh(id);
    setTractLayers((p) => p.filter((l) => l.id !== id));
  };

  // ===== Inflated brain support removed per user request =====

  // ===== Clear all overlays =====
  const clearAllOverlays = async () => {
    await viewerRef.current?.clearAllOverlays();
    setRetState(initRetState);
    setAtlasState(initAtlasState);
    setUserLayers([]);
    setTractLayers([]);
    setOverlayMeta({});
    userFileCache.current = {};
    tractDirectionMap.current = {};
    atlasLabelsRef.current = {};
    setCrosshairLabels({});
    setCrosshairValues([]);
    setSelectedLesionIds(new Set());
    setLayerLabelAtlas({});
    setCrosshairEloquent(null);
    setLesionPickerOpen(false);
    toast.success("All overlays cleared");
  };

  // ===== Workspace save / restore =====
  // Standard atlases & retinotopy reload from static URLs (store settings
  // only). User volumes are embedded as base64 so the workspace is
  // self-contained. Per-layer cal-range fine-tuning restore for user
  // uploads is deferred to v2 (colormap/opacity are restored).
  const getWorkspaceSnapshot = useCallback(async () => {
    const files = {};
    for (const l of userLayers) {
      const cached = userFileCache.current[l.id];
      if (cached?.file) {
        try {
          files[l.id] = { name: cached.file.name, b64: await fileToBase64(cached.file) };
        } catch (_e) { /* skip unreadable file */ }
      }
    }
    return {
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      label: baseLabel,
      view: {
        sliceType, crosshair, crosshairWidth, crosshairColor, clipDepth, clipAz, clipEl, asymmetric, largeSlice,
        baseVisible, baseOpacity, baseColormap, baseColorbarOn, proximityWarn,
      },
      crosshairMM,
      retState,
      atlasState,
      layerLabelAtlas,
      userLayers: userLayers.map((l) => ({
        id: l.id, name: l.name, type: l.type, visible: l.visible,
        opacity: l.opacity, colormap: l.colormap,
      })),
      files,
    };
  }, [userLayers, sliceType, crosshair, crosshairWidth, crosshairColor, clipDepth, clipAz, clipEl,
      asymmetric, largeSlice, baseVisible, baseOpacity, baseColormap, baseColorbarOn,
      proximityWarn, crosshairMM, retState, atlasState, layerLabelAtlas, baseLabel]);

  const applyWorkspace = useCallback(async (ws) => {
    if (!ws || (ws.version !== 1 && ws.version !== WORKSPACE_VERSION)) {
      toast.error("Unsupported workspace file");
      return;
    }
    await clearAllOverlays();
    // View settings
    const v = ws.view || {};
    setSliceType(v.sliceType ?? "multiplanar");
    setCrosshair(v.crosshair ?? true);
    if (v.crosshairWidth != null) setCrosshairWidth(v.crosshairWidth);
    if (v.crosshairColor) setCrosshairColor(v.crosshairColor);
    setClipDepth(v.clipDepth ?? 2);
    setClipAz(v.clipAz ?? 0);
    setClipEl(v.clipEl ?? 0);
    setAsymmetric(!!v.asymmetric);
    if (v.largeSlice) setLargeSlice(v.largeSlice);
    setBaseVisible(v.baseVisible ?? true);
    viewerRef.current?.setBaseVisible(v.baseVisible ?? true);
    if (v.baseOpacity != null) { setBaseOpacity(v.baseOpacity); viewerRef.current?.setBaseOpacity(v.baseOpacity); }
    if (v.baseColormap) { setBaseColormap(v.baseColormap); viewerRef.current?.setBaseColormap(v.baseColormap); }
    if (v.baseColorbarOn != null) { setBaseColorbarOn(!!v.baseColorbarOn); viewerRef.current?.setBaseColorbarVisible(!!v.baseColorbarOn); }
    setProximityWarn(!!v.proximityWarn);

    // Re-add user volumes from embedded bytes
    for (const l of ws.userLayers || []) {
      const f = ws.files?.[l.id];
      if (!f?.b64) continue;
      const file = base64ToFile(f.b64, f.name || `${l.type}.nii.gz`);
      await addUserFile(file, l.type, { colormap: l.colormap, opacity: l.opacity });
    }

    // Restore standard atlases that were visible
    for (const a of STANDARD_ATLASES) {
      if (ws.atlasState?.[a.id]?.visible) {
        await handleAtlasToggle(a.id);
        const s = ws.atlasState[a.id];
        if (typeof s.opacity === "number") handleAtlasOpacity(a.id, s.opacity);
        if (s.colormap) handleAtlasColormap(a.id, s.colormap);
      }
    }
    // Restore retinotopy layers that were visible
    for (const r of ALL_RETINOTOPY_LAYERS) {
      if (ws.retState?.[r.id]?.visible) {
        await handleRetToggle(r.id);
        const s = ws.retState[r.id];
        if (typeof s.opacity === "number") handleRetOpacity(r.id, s.opacity);
        if (s.colormap) handleRetColormap(r.id, s.colormap);
      }
    }
    if (ws.crosshairMM) viewerRef.current?.setCrosshairMM?.(...ws.crosshairMM);
    toast.success("Workspace restored");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearAllOverlays]);

  const handleSaveWorkspace = async () => {
    try {
      const snap = await getWorkspaceSnapshot();
      const ok = await saveWorkspace(snap);
      if (ok) toast.success("Workspace saved");
    } catch (e) {
      toast.error("Save failed", { description: e?.message });
    }
  };
  const handleOpenWorkspace = async () => {
    try {
      const ws = await openWorkspace();
      if (ws) await applyWorkspace(ws);
    } catch (e) {
      toast.error("Open failed", { description: e?.message });
    }
  };

  // Toggle Eloquent Warn. Updates the ref synchronously before React re-renders
  // so any in-flight onLocationChange events immediately see the new value and
  // stop calling setCrosshairEloquent — eliminating the banner-persists race.
  const handleProximityWarnToggle = useCallback(() => {
    const next = !proximityWarnRef.current;
    proximityWarnRef.current = next;
    if (!next) {
      setCrosshairEloquent(null);
      lastEloquentMM.current = null;
      // Hide the silently-loaded Jülich atlas so it leaves no visual trace on
      // the canvas. Guard: only zero the opacity if the user hasn't explicitly
      // turned the atlas on via the Atlas panel (atlasStateRef tracks that).
      if (!atlasStateRef.current.juelich?.visible) {
        viewerRef.current?.setOverlayOpacity("juelich", 0);
      }
    } else {
      ensureAtlasLoaded("juelich", { silent: true });
    }
    setProximityWarn(next);
  }, [ensureAtlasLoaded]);

  // ===== Side effects =====
  useEffect(() => { viewerRef.current?.setClipPlane(clipDepth, clipAz, clipEl); }, [clipDepth, clipAz, clipEl]);


  useEffect(() => {
    const el = canvasWrapperRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      if (!e.ctrlKey) return;          // plain scroll → NiiVue owns the event → zoom
      const adjust = scrollAdjustRef.current;
      if (!adjust) return;             // no slider touched yet → NiiVue zooms as fallback
      e.preventDefault();
      e.stopPropagation();             // capture phase — canvas never receives the event
      adjust(e.deltaY > 0 ? -1 : 1);
    };
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', handleWheel, { capture: true });
  }, []);  // empty deps: single stable registration, scrollAdjustRef.current is always live
  useEffect(() => { viewerRef.current?.setCrosshair(crosshair); }, [crosshair]);
  useEffect(() => {
    const colorMap = {
      white:  [0.95, 0.95, 0.95, 0.85],
      red:    [1.0,  0.23, 0.19, 1.0 ],
      yellow: [1.0,  0.95, 0.0,  1.0 ],
      cyan:   [0.0,  0.87, 0.87, 1.0 ],
      green:  [0.2,  0.87, 0.35, 1.0 ],
    };
    viewerRef.current?.setCrosshairStyle({
      width: crosshair ? crosshairWidth : 0,
      color: colorMap[crosshairColor] || colorMap.white,
    });
  }, [crosshair, crosshairWidth, crosshairColor]);
  // Apply asymmetric layout whenever toggle or largeSlice changes
  useEffect(() => {
    if (!viewerReady) return;
    viewerRef.current?.setAsymmetricLayout(asymmetric ? largeSlice : null);
  }, [asymmetric, largeSlice, viewerReady]);

  // Double-click in asymmetric mode → promote the clicked side view
  const handleDoubleClickSlice = useCallback((slice) => {
    if (!asymmetric || !slice) return;
    setLargeSlice(slice);
  }, [asymmetric]);

  // ===== Derived counts =====
  const polarActive = retState.benson_polar_angle?.visible;
  const eccenActive = retState.benson_eccentricity?.visible;
  const lesionLayers = userLayers.filter((l) => l.type === "lesion");
  const roiLayers = userLayers.filter((l) => l.type === "roi");
  const activationLayers = userLayers.filter((l) => l.type === "activation");
  const customAtlases = userLayers.filter((l) => l.type === "atlas");

  // ===== Lesion-aware retinotopy legend =====
  // Auto-load polar/eccen atlases (silent, opacity 0) the first time any
  // lesion layer exists. Cheap files; loading once means the legend reflects
  // overlap even when the user hasn't toggled the retinotopy layer on.
  const anyLesion = lesionLayers.length > 0;
  useEffect(() => {
    if (!anyLesion) return;
    ensureRetinotopyLoaded("benson_polar_angle", { silent: true });
    ensureRetinotopyLoaded("benson_eccentricity", { silent: true });
    ensureRetinotopyLoaded("wm_polar_angle", { silent: true });
    ensureRetinotopyLoaded("wm_eccentricity", { silent: true });
  }, [anyLesion, ensureRetinotopyLoaded]);

  // Drop removed lesions from the picker selection so the analysis stays in sync.
  const lesionIdsKey = lesionLayers.map((l) => l.id).join("|");
  useEffect(() => {
    setSelectedLesionIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(lesionLayers.map((l) => l.id));
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [lesionIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-atlas per-lesion voxel-count maps. Memoized on the set of selected
  // lesion ids + the atlas-load tick. Cheap (~10k voxels) so no worker.
  // viewerRef is a mutable ref, so retAtlasTick and lesionIdsKey are sentinel
  // triggers that force re-evaluation when an atlas (re)loads or the lesion
  // set changes. eslint can't see through them; the deps are intentional.
  const polarCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("benson_polar_angle");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = viewer?.getVolume?.(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey]);

  const eccenCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("benson_eccentricity");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = viewer?.getVolume?.(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey]);

  const polarOverlap = useMemo(() => {
    const set = affectedSet(polarCounts, { mode: polarThresh.mode, minVoxels: polarThresh.min });
    const ranges = mergeRanges(set, { wrap: true, maxDeg: 360 });
    const hemifield = classifyHemifield(polarCounts);
    const summary = selectedLesionIds.size === 0
      ? "select a lesion to see overlap"
      : buildSummary({ displayRanges: ranges.displayRanges, hemifield, kind: "polar" });
    return { ...ranges, summary };
  }, [polarCounts, polarThresh, selectedLesionIds.size]);

  const eccenOverlap = useMemo(() => {
    const set = affectedSet(eccenCounts, { mode: eccenThresh.mode, minVoxels: eccenThresh.min });
    const ranges = mergeRanges(set, { wrap: false, maxDeg: 90 });
    const summary = selectedLesionIds.size === 0
      ? "select a lesion to see overlap"
      : buildSummary({ displayRanges: ranges.displayRanges, kind: "eccen" });
    return { ...ranges, summary };
  }, [eccenCounts, eccenThresh, selectedLesionIds.size]);

  // ===== White-matter (template) overlap =====
  // Same machinery as the cortical legend, but against the population
  // white-matter retinotopy maps (wm_polar_angle / wm_eccentricity). These load
  // only when the user toggles the WM layer on (the .nii.gz may be absent), so
  // wmAvailable gates the legend. Thresholds are shared with the cortical legend.
  const wmPolarCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("wm_polar_angle");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = viewer?.getVolume?.(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey]);

  const wmEccenCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("wm_eccentricity");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = viewer?.getVolume?.(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey]);

  // True once a WM map is actually loaded (user toggled it on). retAtlasTick is a
  // sentinel so this re-reads the ref after a (un)load.
  const wmAvailable = useMemo(() => {
    const viewer = viewerRef.current;
    return !!(viewer?.getVolume?.("wm_polar_angle")?.img || viewer?.getVolume?.("wm_eccentricity")?.img);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retAtlasTick]);

  const wmPolarOverlap = useMemo(() => {
    const set = affectedSet(wmPolarCounts, { mode: polarThresh.mode, minVoxels: polarThresh.min });
    const ranges = mergeRanges(set, { wrap: true, maxDeg: 360 });
    const hemifield = classifyHemifield(wmPolarCounts);
    const summary = selectedLesionIds.size === 0
      ? "select a lesion to see overlap"
      : buildSummary({ displayRanges: ranges.displayRanges, hemifield, kind: "polar" });
    return { ...ranges, summary };
  }, [wmPolarCounts, polarThresh, selectedLesionIds.size]);

  const wmEccenOverlap = useMemo(() => {
    const set = affectedSet(wmEccenCounts, { mode: eccenThresh.mode, minVoxels: eccenThresh.min });
    const ranges = mergeRanges(set, { wrap: false, maxDeg: 90 });
    const summary = selectedLesionIds.size === 0
      ? "select a lesion to see overlap"
      : buildSummary({ displayRanges: ranges.displayRanges, kind: "eccen" });
    return { ...ranges, summary };
  }, [wmEccenCounts, eccenThresh, selectedLesionIds.size]);

  // ===== 2D polar visual-field grid computations =====
  const benson2DGrid = useMemo(() => {
    const viewer = viewerRef.current;
    const pa = viewer?.getVolume?.("benson_polar_angle");
    const ec = viewer?.getVolume?.("benson_eccentricity");
    if (!pa?.img || !ec?.img || selectedLesionIds.size === 0) return null;
    const grids = [];
    for (const id of selectedLesionIds) {
      const lv = viewer?.getVolume?.(id);
      if (lv?.img) grids.push(computeVoxelCounts2D(lv, pa, ec));
    }
    return unionGrids(grids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey]);

  const wm2DGrid = useMemo(() => {
    const viewer = viewerRef.current;
    const pa = viewer?.getVolume?.("wm_polar_angle");
    const ec = viewer?.getVolume?.("wm_eccentricity");
    if (!pa?.img || !ec?.img || selectedLesionIds.size === 0) return null;
    const grids = [];
    for (const id of selectedLesionIds) {
      const lv = viewer?.getVolume?.(id);
      if (lv?.img) grids.push(computeVoxelCounts2D(lv, pa, ec));
    }
    return unionGrids(grids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey]);

  const toggleLesionSelected = (id) => {
    setSelectedLesionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const retActive = Object.values(retState).filter((s) => s.visible).length;
  const stdAtlasActive = Object.values(atlasState).filter((s) => s.visible).length;
  const totalActive =
    retActive + stdAtlasActive +
    userLayers.filter((l) => l.visible).length +
    tractLayers.filter((l) => l.visible).length;

  // Color-bar entries: only CONTINUOUS overlays (lesion, ROI, activation,
  // custom atlas, retinotopy maps). Standard atlases (AAL/HO/Jülich/Destrieux)
  // and Wang max-prob are categorical — skipped per product spec.
  const colorBarEntries = useMemo(() => {
    const out = [];
    for (const l of userLayers) {
      if (!l.visible) continue;
      const m = overlayMeta[l.id];
      if (!m) continue;
      out.push({
        id: l.id, name: l.name, colormap: l.colormap,
        calMin: m.cal_min,
        calMax: m.cal_max,
        globalMin: m.global_min, globalMax: m.global_max,
      });
    }
    for (const r of ALL_RETINOTOPY_LAYERS) {
      if (!retState[r.id]?.visible) continue;
      const m = overlayMeta[r.id];
      if (!m) continue;
      out.push({
        id: r.id, name: r.name, colormap: retState[r.id].colormap,
        calMin: m.cal_min,
        calMax: m.cal_max,
        globalMin: m.global_min, globalMax: m.global_max,
      });
    }
    return out;
  }, [userLayers, retState, overlayMeta]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#050505] text-[#F4F4F5]" data-testid="dashboard-root">
      <SplashScreen ready={viewerReady} />
      {/* ============ SIDEBAR ============ */}
      <aside className="w-[400px] flex-shrink-0 border-r border-[#27272A] bg-[#0a0a0a] flex flex-col" data-testid="sidebar">
        <div className="border-b border-[#27272A] px-5 py-4 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center border border-[#27272A]">
            <Brain size={16} className="text-white" />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-semibold tracking-tight leading-none">NeuroVue</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500 mt-1">
              base · lesion · roi · activation · atlas · tracts
            </div>
          </div>
          <div className="font-mono text-[10px] text-zinc-500" data-testid="active-count">
            {totalActive} active
          </div>
        </div>

        <div className="flex-1 overflow-y-auto thin-scroll">
          {/* === 1. Base Volume === */}
          <SidebarSection title="Base Volume" icon={ImageIcon} testId="section-base" defaultOpen={true}>
            <div className="flex items-center justify-end px-1 pb-1">
              <div className={`h-1.5 w-1.5 rounded-full ${viewerReady ? "bg-emerald-500" : "bg-amber-500"}`} title={viewerReady ? "WebGL ready" : "Loading"} />
            </div>
            <LayerControlAdvanced
              layer={{ id: "mni152", name: baseLabel, description: BASE_VOLUME.description }}
              visible={baseVisible}
              opacity={baseOpacity}
              colormap={baseColormap}
              globalMin={baseOverlayMeta.global_min}
              globalMax={baseOverlayMeta.global_max}
              calMin={baseOverlayMeta.cal_min}
              calMax={baseOverlayMeta.cal_max}
              isSigned={false}
              showColormap
              onToggle={handleBaseVisibilityToggle}
              onOpacityChange={handleBaseOpacity}
              onColormapChange={handleBaseColormap}
              onCalRangeChange={handleBaseCalRange}
            />
            <div className="flex items-center justify-between px-3 py-1.5 border border-t-0 border-[#27272A] bg-[#0a0a0a]">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">colorbar</span>
              <button
                onClick={() => handleBaseColorbarToggle(null, !baseColorbarOn)}
                className={`relative inline-flex h-4 w-8 transition-colors border ${
                  baseColorbarOn ? "bg-white border-white" : "bg-transparent border-[#27272A]"
                }`}
                data-testid="toggle-base-colorbar"
              >
                <span className={`inline-block h-3 w-3 transition-transform ${baseColorbarOn ? "translate-x-4 bg-black" : "translate-x-0 bg-zinc-500"}`} />
              </button>
            </div>
            <FileUploader
              label="Use Custom Base Image"
              description=".nii / .nii.gz / .mgz — replaces MNI152"
              testId="upload-base-button"
              onFile={handleBaseUpload}
            />
            <FileUploader
              label="Import DICOM Series"
              description="select a folder of .dcm files (or a .zip) — server-side dcm2niix"
              testId="upload-dicom-button"
              directory
              accept=".dcm,.ima,.zip"
              onFiles={handleDicomImport}
            />

            {/* DICOM staged progress bar */}
            {dicomProgress && (
              <div className="space-y-1" data-testid="dicom-progress">
                <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
                  <span>
                    {dicomProgress.stage === "upload" ? "Uploading" :
                      dicomProgress.stage === "convert" ? "Converting (dcm2niix)" : "Loading series"}
                  </span>
                  {dicomProgress.stage === "upload" && (
                    <span>{Math.round(dicomProgress.fraction * 100)}%</span>
                  )}
                </div>
                <div className="h-1 w-full bg-[#27272A] overflow-hidden">
                  <div
                    className={`h-full bg-white transition-all ${dicomProgress.stage !== "upload" ? "animate-pulse" : ""}`}
                    style={{ width: dicomProgress.stage === "upload" ? `${dicomProgress.fraction * 100}%` : "100%" }}
                  />
                </div>
              </div>
            )}

            {/* DICOM series picker (multi-series studies) */}
            {dicomJob && (
              <div className="space-y-1.5 border border-[#27272A] p-2" data-testid="dicom-series-picker">
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
                  {dicomJob.series.length} series — pick one
                </div>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {dicomJob.series.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => loadDicomSeries(dicomJob.jobId, s)}
                      className={`w-full text-left px-2 py-1.5 border hover:border-zinc-500 hover:text-white ${
                        s.id === loadedSeriesId
                          ? "bg-[#111827] border-emerald-700 text-white"
                          : "bg-transparent border-[#27272A] text-zinc-300"
                      }`}
                      data-testid={`dicom-series-${s.id}`}
                    >
                      <div className="text-[11px] truncate">
                        {s.id === loadedSeriesId && <span className="text-emerald-500">✓ </span>}
                        {s.description || s.id}
                      </div>
                      <div className="font-mono text-[9px] text-zinc-600">
                        {s.dims ? s.dims.join("×") : "?"} · {s.n_slices ?? "?"} slices · {(s.bytes / 1e6).toFixed(1)} MB
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => { setDicomJob(null); setLoadedSeriesId(null); }}
                  className="w-full py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-zinc-500 border-[#27272A] hover:text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Download the currently-loaded DICOM series as NIfTI */}
            {dicomDownload && (
              <a
                href={dicomSeriesDownloadUrl(dicomDownload.jobId, dicomDownload.seriesId)}
                download={`${dicomDownload.seriesId}.nii.gz`}
                title={`Download “${dicomDownload.name}” as NIfTI (.nii.gz)`}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 mt-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500 no-underline"
                data-testid="download-dicom-nifti"
              >
                <Download size={13} /> Download NIfTI
              </a>
            )}
            {baseLabel !== BASE_VOLUME.name && (
              <button
                onClick={handleResetBase}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 mt-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
                data-testid="reset-base-button"
              >
                <RotateCcw size={12} />Reset to MNI Template
              </button>
            )}
          </SidebarSection>

          {/* === 2. Lesion Masks === */}
          <SidebarSection title="Load Lesion Mask" icon={Plus} testId="section-lesion" defaultOpen={false}
            badge={lesionLayers.filter((l) => l.visible).length}>
            <FileUploader label="Load Lesion Mask" description=".nii / .nii.gz / .mgz — overlaid in red"
              variant="danger" testId="upload-lesion-button" onFile={(f) => addUserFile(f, "lesion")} />
            {lesionLayers.length > 0 && (
              <div className="mt-2">
                <OneClickSummaryPanel
                  viewerRef={viewerRef}
                  lesionLayers={lesionLayers}
                  standardAtlases={STANDARD_ATLASES}
                  atlasLabelsRef={atlasLabelsRef}
                  ensureAtlasLoaded={ensureAtlasLoaded}
                  userFileCache={userFileCache}
                  getPolarDiscDataUrl={() => polarAngleDiscToDataURL({
                    colormap: retState.benson_polar_angle.colormap,
                    arcSegments: polarOverlap.arcSegments,
                    summaryText: polarOverlap.summary,
                    baseLabel,
                    eccenColormap: retState.benson_eccentricity.colormap,
                    eccenArcSegments: eccenOverlap.arcSegments,
                    eccenSummaryText: eccenOverlap.summary,
                    eccenInverted,
                  })}
                  getVfMap2dDataUrl={async (lesionId) => {
                    // Build the 2D VF map for the summary's OWN selected lesion —
                    // independent of the Retinotopy panel's transient state
                    // (selectedLesionIds / layer visibility). Ensure the Benson
                    // atlases are loaded, sample the deficit grid for that lesion,
                    // and force the deficit render gates on.
                    const viewer = viewerRef.current;
                    await ensureRetinotopyLoaded("benson_polar_angle", { silent: true });
                    await ensureRetinotopyLoaded("benson_eccentricity", { silent: true });
                    const pa = viewer?.getVolume?.("benson_polar_angle");
                    const ec = viewer?.getVolume?.("benson_eccentricity");
                    const lv = viewer?.getVolume?.(lesionId);
                    const grid = (pa?.img && ec?.img && lv?.img)
                      ? computeVoxelCounts2D(lv, pa, ec)
                      : null;
                    return await visualFieldMap2DDataURL({
                      gridResult: grid,
                      active: true,
                      selectedCount: 1,
                      thresholdMode: polarThresh.mode,
                      thresholdMin: polarThresh.min,
                    });
                  }}
                />
              </div>
            )}
            <UserLayerList layers={lesionLayers} overlayMeta={overlayMeta} {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserRemove, handleCalRangeChange, handleIgnoreZeroChange, handleInvertThresholdChange }} />
            {lesionLayers.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#27272A]">
                <OverlapPanel
                  viewerRef={viewerRef}
                  lesionLayers={lesionLayers}
                  atlasOptions={STANDARD_ATLASES.filter((a) => atlasState[a.id]?.visible)}
                  atlasLabelsRef={atlasLabelsRef}
                />
                <div className="mt-3 pt-3 border-t border-[#27272A]">
                  <LesionReportPanel
                    viewerRef={viewerRef}
                    lesionLayers={lesionLayers}
                    standardAtlases={STANDARD_ATLASES}
                    visibleAtlasIds={STANDARD_ATLASES.filter((a) => atlasState[a.id]?.visible).map((a) => a.id)}
                    atlasLabelsRef={atlasLabelsRef}
                    ensureAtlasLoaded={ensureAtlasLoaded}
                    retinotopyLayers={ALL_RETINOTOPY_LAYERS
                      .filter((l) => l.legendType === "polar" || l.legendType === "eccen")
                      .map((l) => ({
                        id: l.id,
                        name: l.name,
                        kind: l.legendType,
                        illustrative: l.id.startsWith("wm_") || l.id.startsWith("lgn_") || l.id.startsWith("or_"),
                        attribution: l.attribution || null,
                      }))}
                    getPolarDiscDataUrl={() => polarAngleDiscToDataURL({
                      colormap: retState.benson_polar_angle.colormap,
                      arcSegments: polarOverlap.arcSegments,
                      summaryText: polarOverlap.summary,
                      baseLabel,
                      eccenColormap: retState.benson_eccentricity.colormap,
                      eccenArcSegments: eccenOverlap.arcSegments,
                      eccenSummaryText: eccenOverlap.summary,
                      eccenInverted,
                    })}
                    getVfMap2dDataUrl={async () => {
                      const el = bensonVfMap2dRef.current?.getSvgEl?.();
                      if (el) return await visualFieldMap2DToDataURL(el);
                      return await visualFieldMap2DDataURL({
                        gridResult: benson2DGrid,
                        active: polarActive || eccenActive,
                        selectedCount: selectedLesionIds.size,
                        thresholdMode: polarThresh.mode,
                        thresholdMin: polarThresh.min,
                      });
                    }}
                    getWmPolarDiscDataUrl={() => polarAngleDiscToDataURL({
                      colormap: "polar_angle_360",
                      arcSegments: wmPolarOverlap.arcSegments,
                      summaryText: wmPolarOverlap.summary,
                      baseLabel: "WM Retinotopy (population template)",
                      eccenColormap: "warm",
                      eccenArcSegments: wmEccenOverlap.arcSegments,
                      eccenSummaryText: wmEccenOverlap.summary,
                    })}
                    getWmVfMap2dDataUrl={async () => {
                      const el = wmVfMap2dRef.current?.getSvgEl?.();
                      if (el) return await visualFieldMap2DToDataURL(el);
                      return await visualFieldMap2DDataURL({
                        gridResult: wm2DGrid,
                        active: selectedLesionIds.size > 0,
                        selectedCount: selectedLesionIds.size,
                      });
                    }}
                  />
                </div>
              </div>
            )}
          </SidebarSection>

          {/* === 2b. Add ROI (sphere) === */}
          <SidebarSection title="Create ROI" icon={Target} testId="section-add-roi" defaultOpen={false}>
            <AddROIPanel viewerRef={viewerRef} />
          </SidebarSection>

          {/* === 3. Custom ROIs === */}
          <SidebarSection title="Upload ROI" icon={Layers} testId="section-roi" defaultOpen={false}
            badge={roiLayers.filter((l) => l.visible).length}>
            <FileUploader label="Load ROI" description=".nii / .nii.gz / .mgz — multi-ROI supported"
              testId="upload-roi-button" onFile={(f) => addUserFile(f, "roi")} />
            <UserLayerList layers={roiLayers} overlayMeta={overlayMeta} {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserRemove, handleCalRangeChange, handleIgnoreZeroChange, handleInvertThresholdChange }} />
          </SidebarSection>

          {/* === 4. Activation Maps === */}
          <SidebarSection title="Activation Maps" icon={FlaskConical} testId="section-activation" defaultOpen={false}
            badge={activationLayers.filter((l) => l.visible).length}>
            <FileUploader label="Load Activation Map(s)" description=".nii / .nii.gz — t-stat or z-score maps; multi-select supported"
              testId="upload-activation-button" multiple
              onFiles={async (files) => { for (const f of files) await addUserFile(f, "activation"); }}
              onFile={(f) => addUserFile(f, "activation")} />
            <UserLayerList
              layers={activationLayers}
              overlayMeta={overlayMeta}
              labelAtlasOptions={STANDARD_ATLASES.map((a) => ({ id: a.id, name: a.name, short: a.short || a.id }))}
              layerLabelAtlas={layerLabelAtlas}
              onLabelAtlasChange={handleLayerLabelAtlasChange}
              {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserRemove, handleCalRangeChange, handleIgnoreZeroChange, handleInvertThresholdChange }}
            />
            {activationLayers.length > 0 && (
              <ClusterPanel
                viewerRef={viewerRef}
                activationLayers={activationLayers.filter((l) => l.visible)}
                atlasOptions={STANDARD_ATLASES}
                onSelectAtlas={(id) => handleLayerLabelAtlasChange(activationLayers[0]?.id, id)}
                atlasLabelsRef={atlasLabelsRef}
              />
            )}
          </SidebarSection>

          {/* === 4b. Tract Dissection === */}
          <SidebarSection title="Tract Dissection" icon={GitBranch} testId="section-tract-dissect" defaultOpen={false}>
            <TractDissectionPanel
              viewerRef={viewerRef}
              lesionLayers={lesionLayers}
              userFileCache={userFileCache}
            />
          </SidebarSection>

          {/* === 4c. Lesion Network Mapping (degree-adjusted) === */}
          <SidebarSection title="Lesion Network Mapping" icon={Network} testId="section-lnm" defaultOpen={false}>
            <DaLnMapperPanel
              viewerRef={viewerRef}
              lesionLayers={lesionLayers}
              userFileCache={userFileCache}
            />
          </SidebarSection>

          {/* === 5. Draw Lesion === */}
          <SidebarSection title="Draw Lesion" icon={PencilRuler} testId="section-drawing" defaultOpen={false}>
            <DrawingPanel viewerRef={viewerRef} baseName={baseLabel} />
          </SidebarSection>

          {/* === 5b. Measurements & Window === */}
          <SidebarSection title="Measurements & Window" icon={Ruler} testId="section-measure" defaultOpen={false}>
            <MeasurePanel viewerRef={viewerRef} crosshairMM={crosshairMM} lesionLayers={lesionLayers} />
          </SidebarSection>

          {/* === 5c. Clip Plane === */}
          <SidebarSection title="Clip Plane" icon={Scissors} testId="section-clip" defaultOpen={false}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 w-10 flex-shrink-0">depth</span>
                <Slider value={[clipDepth]} min={-1} max={2} step={0.05}
                  onValueChange={(v) => {
                    setClipDepth(v[0]);
                    setScrollTarget('Depth');
                    scrollAdjustRef.current = (d) => setClipDepth((p) => Math.max(-1, Math.min(2, p + d * 0.05)));
                  }} className="cursor-pointer flex-1" data-testid="clip-plane-slider" />
                <span className="font-mono text-[10px] text-zinc-300 tabular-nums w-10 text-right">
                  {clipDepth >= 2 ? "off" : clipDepth.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 w-10 flex-shrink-0">az</span>
                <Slider value={[clipAz]} min={-180} max={180} step={5}
                  onValueChange={(v) => {
                    setClipAz(v[0]);
                    setScrollTarget('Az');
                    scrollAdjustRef.current = (d) => setClipAz((p) => Math.max(-180, Math.min(180, p + d * 5)));
                  }} className="cursor-pointer flex-1" data-testid="clip-az-slider" />
                <span className="font-mono text-[10px] text-zinc-300 tabular-nums w-10 text-right">{clipAz}°</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 w-10 flex-shrink-0">el</span>
                <Slider value={[clipEl]} min={-90} max={90} step={5}
                  onValueChange={(v) => {
                    setClipEl(v[0]);
                    setScrollTarget('El');
                    scrollAdjustRef.current = (d) => setClipEl((p) => Math.max(-90, Math.min(90, p + d * 5)));
                  }} className="cursor-pointer flex-1" data-testid="clip-el-slider" />
                <span className="font-mono text-[10px] text-zinc-300 tabular-nums w-10 text-right">{clipEl}°</span>
              </div>
              <button
                onClick={() => { setClipDepth(2); setClipAz(0); setClipEl(0); }}
                className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors"
                data-testid="clip-plane-reset"
              >reset</button>
              <div className="font-mono text-[9px] text-zinc-600 leading-relaxed">
                depth ≥ 2 = no clip · az rotates around vertical axis · el tilts the plane
              </div>
            </div>
          </SidebarSection>

          {/* === 6. Atlases === */}
          <SidebarSection title="Atlases" icon={Database} testId="section-atlases" defaultOpen={false}
            badge={stdAtlasActive + customAtlases.filter((l) => l.visible).length}>
            <div className="space-y-1.5">
              {STANDARD_ATLASES.map((a) => (
                <LayerControlAdvanced
                  key={a.id}
                  layer={a}
                  visible={atlasState[a.id].visible}
                  opacity={atlasState[a.id].opacity}
                  colormap={atlasState[a.id].colormap}
                  onToggle={handleAtlasToggle}
                  onOpacityChange={handleAtlasOpacity}
                  onColormapChange={handleAtlasColormap}
                />
              ))}
            </div>
            <div className="pt-2">
              <FileUploader label="Add Custom Atlas" description=".nii / .nii.gz / .mgz — discrete labels"
                testId="upload-atlas-button" onFile={(f) => addUserFile(f, "atlas")} />
            </div>
            <UserLayerList layers={customAtlases} overlayMeta={overlayMeta} {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserRemove, handleCalRangeChange, handleIgnoreZeroChange, handleInvertThresholdChange }} />
          </SidebarSection>

          {/* === 7. Retinotopy === */}
          <SidebarSection title="Retinotopy" icon={Eye} testId="section-retinotopy" defaultOpen={false} badge={retActive}>
            <div className="space-y-1.5">
              {RETINOTOPY_LAYERS.map((l) => {
                const m = overlayMeta[l.id] || {};
                return (
                  <LayerControlAdvanced
                    key={l.id}
                    layer={l}
                    visible={retState[l.id].visible}
                    opacity={retState[l.id].opacity}
                    colormap={retState[l.id].colormap}
                    globalMin={m.global_min}
                    globalMax={m.global_max}
                    calMin={m.cal_min}
                    calMax={m.cal_max}
                    isSigned={m.isSigned}
                    ignoreZeroVoxels={m.ignoreZeroVoxels}
                    invertThreshold={m.invertThreshold}
                    onToggle={handleRetToggle}
                    onOpacityChange={handleRetOpacity}
                    onColormapChange={handleRetColormap}
                    onCalRangeChange={handleCalRangeChange}
                    onIgnoreZeroChange={handleIgnoreZeroChange}
                    onInvertThresholdChange={handleInvertThresholdChange}
                    onRemove={() => retState[l.id].visible && handleRetToggle(l.id)}
                    removable={retState[l.id].visible}
                  />
                );
              })}
            </div>


            <div className="border border-[#27272A] bg-[#0a0a0a] p-4 space-y-3">
              {/* Lesion-aware legend picker: shared between both wheels. Multi-select
                  via checkboxes so the user can union several lesions or focus on one. */}
              {lesionLayers.length > 0 && (
                <div className="relative" data-testid="retinotopy-lesion-picker">
                  <button
                    type="button"
                    onClick={() => setLesionPickerOpen((o) => !o)}
                    className="w-full flex items-center justify-between px-2 py-1.5 border border-[#27272A] bg-[#050505] text-zinc-300 text-[11px] hover:text-white hover:border-zinc-500"
                    data-testid="retinotopy-lesion-picker-toggle"
                  >
                    <span className="font-mono uppercase tracking-[0.15em] text-[10px]">
                      Lesions for overlap
                    </span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      {selectedLesionIds.size} / {lesionLayers.length}
                    </span>
                  </button>
                  {lesionPickerOpen && (
                    <div className="mt-1 border border-[#27272A] bg-[#050505] divide-y divide-[#1a1a1a]">
                      {lesionLayers.map((l) => {
                        const checked = selectedLesionIds.has(l.id);
                        return (
                          <label
                            key={l.id}
                            className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-zinc-300 hover:text-white cursor-pointer"
                            data-testid={`retinotopy-lesion-opt-${l.id}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleLesionSelected(l.id)}
                              className="accent-zinc-200"
                            />
                            <span className="truncate font-mono">{l.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
                  cortical retinotopy
                </span>
                <button
                  onClick={() => setBensonViewMode((v) => v === "2d" ? "classic" : "2d")}
                  className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500 hover:text-zinc-200 border border-[#27272A] px-2 py-0.5"
                >
                  {bensonViewMode === "2d" ? "classic →" : "← 2D map"}
                </button>
              </div>
              {bensonViewMode === "2d" ? (
                <VisualFieldMap2D
                  ref={bensonVfMap2dRef}
                  gridResult={benson2DGrid}
                  active={polarActive || eccenActive}
                  selectedCount={selectedLesionIds.size}
                  label="Cortical Retinotopy (Benson)"
                  summaryText={polarOverlap.summary}
                  thresholdMode={polarThresh.mode}
                  thresholdMin={polarThresh.min}
                  onThresholdModeChange={(mode) => setPolarThresh((p) => ({ ...p, mode }))}
                  onThresholdMinChange={(min) => setPolarThresh((p) => ({ ...p, min }))}
                  baseLabel={baseLabel}
                />
              ) : (
                <>
                  <PolarAngleDisc
                    active={polarActive}
                    colormap={retState.benson_polar_angle.colormap}
                    arcSegments={polarOverlap.arcSegments}
                    summaryText={polarOverlap.summary}
                    thresholdMode={polarThresh.mode}
                    thresholdMin={polarThresh.min}
                    onThresholdModeChange={(mode) => setPolarThresh((p) => ({ ...p, mode }))}
                    onThresholdMinChange={(min) => setPolarThresh((p) => ({ ...p, min }))}
                    baseLabel={baseLabel}
                    eccenColormap={retState.benson_eccentricity.colormap}
                    eccenArcSegments={eccenOverlap.arcSegments}
                    eccenSummaryText={eccenOverlap.summary}
                    eccenInverted={eccenInverted}
                  />
                  <div className="my-3 h-px bg-[#27272A]" />
                  <EccentricityBar
                    active={eccenActive}
                    colormap={retState.benson_eccentricity.colormap}
                    arcSegments={eccenOverlap.arcSegments}
                    summaryText={eccenOverlap.summary}
                    thresholdMode={eccenThresh.mode}
                    thresholdMin={eccenThresh.min}
                    onThresholdModeChange={(mode) => setEccenThresh((p) => ({ ...p, mode }))}
                    onThresholdMinChange={(min) => setEccenThresh((p) => ({ ...p, min }))}
                    inverted={eccenInverted}
                    onInvertToggle={handleEccenInvert}
                  />
                </>
              )}
              {/* White-matter (template) overlap — illustrative only. Uses the
                  same polar/eccen thresholds as the cortical legend above. */}
              <div className="my-3 h-px bg-[#27272A]" />
              <div className="space-y-3" data-testid="wm-retinotopy-legend">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                    brainlife · retinotopic connectivity template
                  </div>
                  {wmAvailable && (
                    <button
                      onClick={() => setWmInlineViewMode((v) => v === "2d" ? "classic" : "2d")}
                      className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500 hover:text-zinc-200 border border-[#27272A] px-2 py-0.5"
                    >
                      {wmInlineViewMode === "2d" ? "classic →" : "← 2D map"}
                    </button>
                  )}
                </div>
                {wmAvailable ? (
                  <>
                    {wmInlineViewMode === "2d" ? (
                      <VisualFieldMap2D
                        ref={wmVfMap2dRef}
                        gridResult={wm2DGrid}
                        active={selectedLesionIds.size > 0}
                        selectedCount={selectedLesionIds.size}
                        label="WM Retinotopy (population template)"
                        summaryText={wmPolarOverlap.summary}
                        baseLabel="WM Retinotopy (population template)"
                      />
                    ) : (
                      <>
                        <PolarAngleDisc
                          active={selectedLesionIds.size > 0}
                          colormap="polar_angle_360"
                          arcSegments={wmPolarOverlap.arcSegments}
                          summaryText={wmPolarOverlap.summary}
                          baseLabel="WM Retinotopy (population template)"
                          eccenColormap="warm"
                          eccenArcSegments={wmEccenOverlap.arcSegments}
                          eccenSummaryText={wmEccenOverlap.summary}
                        />
                        <EccentricityBar
                          active={selectedLesionIds.size > 0}
                          colormap="warm"
                          arcSegments={wmEccenOverlap.arcSegments}
                          summaryText={wmEccenOverlap.summary}
                        />
                      </>
                    )}
                    <div className="font-mono text-[8px] text-zinc-600 leading-relaxed pt-1">
                      Anatomical/illustrative · population template, not a validated clinical
                      prediction · Amorosino et al. 2026 · brainlife.pub.67 (CC-BY)
                    </div>
                  </>
                ) : (
                  <div className="text-[10px] text-zinc-500 leading-relaxed">
                    White-matter retinotopy maps are loading. If they fail, ensure{" "}
                    <span className="font-mono">wm_polar_angle.nii.gz</span> and{" "}
                    <span className="font-mono">wm_eccentricity.nii.gz</span> are present in{" "}
                    <span className="font-mono">public/atlases/</span>.
                  </div>
                )}
              </div>
            </div>
          </SidebarSection>

          {/* === 8. Tractography === */}
          <SidebarSection title="Tractography" icon={Waypoints} testId="section-tracts" defaultOpen={false}
            badge={tractLayers.filter((l) => l.visible).length}>
            <FileUploader label="Load Tract File" description=".trk / .tck / .trx / .vtk / .gii / .mz3"
              accept=".trk,.tck,.trx,.vtk,.gii,.mz3,.obj,.stl,.ply"
              testId="upload-tract-button" onFile={handleTractUpload}
              disabled={!!tractLoading} />
            {tractLoading && (
              <div className="border border-[#27272A] bg-[#0a0a0a] px-3 py-2.5 mt-2">
                <div className="flex items-center gap-2">
                  <Loader2 size={11} className="animate-spin text-zinc-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[12px] text-zinc-300">{tractLoading.name}</div>
                    <div className="font-mono text-[10px] text-zinc-500 animate-pulse mt-0.5">{tractLoading.phase}</div>
                  </div>
                </div>
                <div className="mt-2 h-px w-full bg-[#27272A] overflow-hidden">
                  <div className="h-px bg-white/60 animate-pulse" style={{ width: "100%" }} />
                </div>
              </div>
            )}
            {tractLoadError && (
              <div className="border border-[#FF3B30]/40 bg-[#0a0a0a] px-3 py-2.5 mt-2">
                <div className="flex items-start gap-2">
                  <AlertCircle size={11} className="text-[#FF3B30] mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[#FF3B30]">Failed to load</div>
                    <div className="font-mono text-[10px] text-zinc-500 mt-0.5 break-all">{tractLoadError.name}</div>
                    <div className="font-mono text-[10px] text-zinc-400 mt-1 break-words">{tractLoadError.message}</div>
                  </div>
                  <button onClick={() => setTractLoadError(null)} className="text-zinc-600 hover:text-zinc-400 flex-shrink-0">
                    <X size={11} />
                  </button>
                </div>
              </div>
            )}
            {tractLayers.length > 0 && (
              <div className="space-y-1.5 mt-2">
                {tractLayers.map((t) => (
                  <div key={t.id} className="border border-[#27272A] bg-[#0a0a0a] px-3 py-2.5" data-testid={`tract-${t.id}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="inline-block h-3 w-3" style={{ background: t.direction
                        ? "linear-gradient(45deg, #ff3b30, #34c759, #007aff)"
                        : t.color }} />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-[12px] text-zinc-200">{t.name}</div>
                        <div className="font-mono text-[10px] text-zinc-500">{t.description}</div>
                      </div>
                      <button onClick={() => handleTractRemove(t.id)}
                        className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:text-[#FF3B30]"
                        data-testid={`remove-${t.id}`}>remove</button>
                    </div>
                    <label className="flex items-center justify-between cursor-pointer mb-2">
                      <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                        color by direction (DTI · RGB)
                      </span>
                      <button onClick={() => handleTractDirectionToggle(t.id, !t.direction)}
                        className={`relative inline-flex h-4 w-8 transition-colors border ${
                          t.direction ? "bg-white border-white" : "bg-transparent border-[#27272A]"
                        }`}
                        data-testid={`tract-direction-${t.id}`}>
                        <span className={`inline-block h-3 w-3 transition-transform ${
                          t.direction ? "translate-x-4 bg-black" : "translate-x-0 bg-zinc-500"
                        }`} />
                      </button>
                    </label>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">opacity</span>
                      <span className="font-mono text-[10px] text-zinc-300">{Math.round(t.opacity * 100)}%</span>
                    </div>
                    <Slider value={[t.opacity * 100]} max={100} step={1}
                      onValueChange={(v) => handleTractOpacity(t.id, v[0] / 100)}
                      data-testid={`opacity-${t.id}`} />
                  </div>
                ))}
              </div>
            )}
          </SidebarSection>

          {/* === 9. Longitudinal === */}
          <SidebarSection title="Longitudinal" icon={GitCompareArrows} testId="section-longitudinal" defaultOpen={false}>
            <LongitudinalPanel
              onDiffLoaded={(file, opts) => addUserFile(file, "activation", { ...opts, name: `Longitudinal Diff · ${new Date().toLocaleDateString()}` })}
            />
          </SidebarSection>

          <div className="px-5 py-4 mt-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-600 leading-relaxed">
              Atlases: AAL · Harvard-Oxford · Jülich (white matter). Retinotopy: Benson 2014 + Wang 2015. Cerebellum excluded in retinotopy.
            </div>
          </div>
        </div>
      </aside>

      {/* ============ MAIN VIEWER ============ */}
      <main className="flex-1 flex flex-col min-h-0 min-w-0 bg-black relative" data-testid="viewer-main">
        <div className="flex items-center justify-between gap-2 flex-wrap border-b border-[#27272A] bg-[#0a0a0a] px-4 py-2.5" data-testid="topbar">
          <div className="flex items-center gap-1 flex-wrap">
            {SLICE_MODES.map((m) => {
              const Icon = m.icon;
              const active = sliceType === m.id && !asymmetric;
              return (
                <button key={m.id} onClick={() => { setAsymmetric(false); setSliceType(m.id); }}
                  className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                    active ? "bg-white text-black border-white" : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                  }`} data-testid={`slice-mode-${m.id}`}>
                  <Icon size={12} /><span>{m.label}</span>
                </button>
              );
            })}
            {/* Asymmetric: 1 large + 3 stacked side views */}
            <button
              onClick={() => setAsymmetric((v) => !v)}
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                asymmetric ? "bg-white text-black border-white" : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              }`}
              data-testid="slice-mode-asymmetric"
              title="Asymmetric: one large + three stacked side views. Double-click a side to promote."
            >
              <Columns3 size={12} /><span>Asymmetric</span>
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowValidation(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="open-atlas-validation"
              title="View side-by-side verification of Benson 2014 / Wang 2015 atlases">
              <BadgeCheck size={12} />Verify Atlas
            </button>
            <button onClick={clearAllOverlays}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-[#FF3B30] hover:border-[#FF3B30]"
              data-testid="clear-all-overlays">
              <Trash2 size={12} />Clear All
            </button>
            <button onClick={handleProximityWarnToggle}
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                proximityWarn ? "bg-amber-500/20 text-amber-300 border-amber-600" : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              }`} data-testid="proximity-toggle"
              title="Warn when the crosshair is within ~5mm of an eloquent white-matter tract (Jülich)">
              <AlertTriangle size={12} />Eloquent Warn
            </button>
            <div className="relative">
              <div className="flex">
                <button onClick={() => setCrosshair((c) => !c)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                    crosshair ? "bg-[#111111] text-white border-zinc-500" : "bg-transparent text-zinc-500 border-[#27272A] hover:text-white"
                  }`} data-testid="crosshair-toggle">
                  <CrosshairIcon size={12} />Crosshair
                </button>
                <button
                  onClick={() => setShowCrosshairSettings((v) => !v)}
                  className="px-1.5 py-1.5 text-[9px] border border-l-0 border-[#27272A] text-zinc-500 hover:text-white transition-colors"
                  title="Crosshair style options"
                  data-testid="crosshair-settings-toggle"
                >▾</button>
              </div>
              {showCrosshairSettings && (
                <div className="absolute right-0 top-full z-50 mt-1 w-52 border border-[#27272A] bg-[#0a0a0a] p-3 space-y-2.5 shadow-lg" data-testid="crosshair-settings-panel">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">thickness</span>
                      <span className="font-mono text-[10px] text-zinc-300">{crosshairWidth}</span>
                    </div>
                    <Slider value={[crosshairWidth]} min={1} max={5} step={1}
                      onValueChange={(v) => setCrosshairWidth(v[0])}
                      className="cursor-pointer" data-testid="crosshair-width" />
                  </div>
                  <div className="space-y-1.5">
                    <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">color</span>
                    <div className="flex gap-1.5 flex-wrap">
                      {[
                        { key: "white",  bg: "bg-white"        },
                        { key: "red",    bg: "bg-red-500"      },
                        { key: "yellow", bg: "bg-yellow-400"   },
                        { key: "cyan",   bg: "bg-cyan-400"     },
                        { key: "green",  bg: "bg-green-400"    },
                      ].map(({ key, bg }) => (
                        <button
                          key={key}
                          onClick={() => setCrosshairColor(key)}
                          className={`h-5 w-5 ${bg} transition-opacity ${crosshairColor === key ? "ring-2 ring-white ring-offset-1 ring-offset-black" : "opacity-60 hover:opacity-100"}`}
                          data-testid={`crosshair-color-${key}`}
                          title={key}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button onClick={handleSaveWorkspace}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="workspace-save" title="Save the current workspace (scan, overlays, settings) to a file">
              <Save size={12} />Save
            </button>
            <button onClick={handleOpenWorkspace}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="workspace-open" title="Restore a saved workspace file">
              <FolderOpen size={12} />Open
            </button>
            <button onClick={() => viewerRef.current?.saveScreenshot()}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="screenshot-button">
              <Camera size={12} />Screenshot
            </button>
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] border border-[#27272A] text-zinc-500 select-none"
              title={scrollTarget ? `Ctrl+scroll → ${scrollTarget} | Scroll → zoom` : 'Touch a slider to bind Ctrl+scroll to it. Scroll always zooms.'}
              data-testid="scroll-mode-indicator"
            >
              <ZoomIn size={12} />
              {scrollTarget ? `↕ Ctrl+${scrollTarget}` : '↕ Scroll'}
            </div>
          </div>
        </div>

        <div className="border-b border-[#27272A] bg-[#050505] px-4 py-2">
          <CrosshairInfo mm={crosshairMM} vox={crosshairVox} labels={crosshairLabels} values={crosshairValues} eloquent={proximityWarn ? crosshairEloquent : null} />
        </div>

        <div ref={canvasWrapperRef} className="flex-1 relative min-h-0">
          <NiivueViewer
            ref={viewerRef}
            baseVolume={BASE_VOLUME}
            sliceType={sliceType}
            onReady={() => { setViewerReady(true); refreshBaseOverlayMeta(); }}
            onLocationChange={handleLocationChange}
            onDoubleClickSlice={handleDoubleClickSlice}
          />
          <ColorBarStack entries={colorBarEntries} />
        </div>

        <div className="border-t border-[#27272A] bg-[#0a0a0a] px-4 py-2 flex items-center" data-testid="bottom-controls">
          <div className="flex items-center gap-4 ml-auto font-mono text-[10px] text-zinc-500">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${viewerReady ? "bg-emerald-500" : "bg-amber-500"}`} />
              <span>{viewerReady ? "WebGL ready" : "loading"}</span>
            </div>
            <div><span className="text-zinc-600">overlays</span>{" "}<span className="text-zinc-300">{totalActive}</span></div>
          </div>
        </div>
      </main>
      <AtlasValidationPanel open={showValidation} onOpenChange={setShowValidation} />
    </div>
  );
}

const UserLayerList = ({
  layers, overlayMeta,
  handleUserToggle, handleUserOpacity, handleUserColormap, handleUserRemove,
  handleCalRangeChange, handleIgnoreZeroChange, handleInvertThresholdChange,
  labelAtlasOptions, layerLabelAtlas, onLabelAtlasChange,
}) =>
  layers.length === 0 ? null : (
    <div className="space-y-1.5 mt-2">
      {layers.map((l) => {
        const m = overlayMeta?.[l.id] || {};
        return (
          <LayerControlAdvanced
            key={l.id}
            layer={l}
            visible={l.visible}
            opacity={l.opacity}
            colormap={l.colormap}
            globalMin={m.global_min}
            globalMax={m.global_max}
            calMin={m.cal_min}
            calMax={m.cal_max}
            isSigned={m.isSigned}
            ignoreZeroVoxels={m.ignoreZeroVoxels}
            invertThreshold={m.invertThreshold}
            labelAtlasOptions={labelAtlasOptions}
            labelAtlasId={layerLabelAtlas?.[l.id]}
            onLabelAtlasChange={onLabelAtlasChange}
            onToggle={handleUserToggle}
            onOpacityChange={handleUserOpacity}
            onColormapChange={handleUserColormap}
            onCalRangeChange={handleCalRangeChange}
            onIgnoreZeroChange={handleIgnoreZeroChange}
            onInvertThresholdChange={handleInvertThresholdChange}
            onRemove={handleUserRemove}
            removable
          />
        );
      })}
    </div>
  );

function typeLabel(t) {
  return { lesion: "Lesion", roi: "ROI", activation: "Activation", atlas: "Atlas" }[t] || "Layer";
}

function shortAtlas(name) {
  return ({
    aal: "AAL",
    ho_cort: "HO Cort",
    juelich: "Jülich",
    destrieux: "Destrieux",
  })[name] || name;
}

function shortLayerName(name) {
  if (!name) return "";
  const map = {
    mni152: "MNI152",
    wang2015_maxprob: "Wang",
    benson_polar_angle: "PolarAng",
    benson_eccentricity: "Eccen",
    benson_visual_areas: "VArea",
    visfAtlas: "visfAtlas",
  };
  if (map[name]) return map[name];
  const sa = shortAtlas(name);
  if (sa !== name) return sa;
  // User-uploaded layers carry IDs like "user-1234567890". Trim ids.
  if (name.startsWith("user-")) return "User";
  return name.length > 12 ? name.slice(0, 12) + "…" : name;
}
