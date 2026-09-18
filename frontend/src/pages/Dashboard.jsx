import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Brain, LayoutGrid, Box, Camera, Crosshair as CrosshairIcon, Activity, Scissors,
  Eye, Layers, FlaskConical, PencilRuler, Database, Plus, Image as ImageIcon, Waypoints, Trash2,
  RotateCcw, Columns3, Ruler, Save, FolderOpen,
  GitCompareArrows, GitBranch, Loader2, AlertCircle, X, Target, Network, Download,
  PanelLeftClose, PanelLeftOpen, PanelTopClose, PanelTopOpen, Sun, Moon,
  FlipHorizontal2, Minimize2, Contrast, Move, Keyboard, ZoomIn, FileCode,
  ChevronsDownUp, ChevronsUpDown, Package, Pencil,
} from "lucide-react";
import NiivueViewer from "@/components/NiivueViewer";
import GotoMniInput from "@/components/GotoMniInput";
import SplashScreen from "@/components/SplashScreen";
import LayerControl from "@/components/LayerControl";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";
import ColorBarStack from "@/components/ColorBarStack";
import FrameStepper from "@/components/FrameStepper";
import FileUploader from "@/components/FileUploader";
import { PolarAngleDisc, EccentricityBar, polarAngleDiscToDataURL } from "@/components/PolarAngleDisc";
import { SidebarSection, SidebarSectionsContext, useSidebarSectionsController } from "@/components/SidebarSection";
import { CrosshairInfo } from "@/components/CrosshairInfo";
import { DrawingPanel } from "@/components/DrawingPanel";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useTheme } from "@/hooks/use-theme";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// Code-split the heavy, mount-gated panels: each is only rendered inside a
// collapsed SidebarSection (or a dialog), so lazyWithRetry defers its chunk
// until the user actually opens it, and retries once on network failure.
// SidebarSection provides the Suspense + ChunkErrorBoundary.
const MeasurePanel         = lazyWithRetry(() => import("@/components/MeasurePanel"));
const LongitudinalPanel    = lazyWithRetry(() => import("@/components/LongitudinalPanel"));
const TractDissectionPanel = lazyWithRetry(() => import("@/components/TractDissectionPanel"));
const DaLnMapperPanel      = lazyWithRetry(() => import("@/components/DaLnMapperPanel"));
import { Slider } from "@/components/ui/slider";
import {
  BASE_VOLUME, RETINOTOPY_LAYERS, WHITE_MATTER_RETINOTOPY_LAYERS,
  WANG_LABELS, VAREA_LABELS,
} from "@/lib/atlasConfig";
// Atlases come from the registry (/api/atlases), not a hardcoded array. The
// old STANDARD_ATLASES constant could not react to an install, an uninstall or
// a reorder, and had drifted to list 6 of the 11 atlases actually on disk.
import { useAtlases, useAtlasRegions, useResolveAtlas } from "@/hooks/use-atlases";
import { patchAtlas, regionMask } from "@/lib/atlasApi";
import { toNameMap } from "@/lib/atlasLabels";
// Cortical (Benson) + white-matter (template) layers share the same
// toggle/load/colorbar plumbing. The WM .nii.gz files are produced offline and
// may be absent — toggling one surfaces a "failed to load" toast (graceful), and
// the legend stays empty until installed.
const ALL_RETINOTOPY_LAYERS = [
  ...RETINOTOPY_LAYERS,
  ...WHITE_MATTER_RETINOTOPY_LAYERS,
];

// Fold an angle into [-180, 180) — used by the clip-plane az/el right-drag so
// a sustained drag wraps continuously instead of pinning at a slider end.
const wrapTurn = (deg) => (((deg + 180) % 360) + 360) % 360 - 180;
import { VISFATLAS_NAV_MM } from "@/lib/visfAtlasColormap";
import { robustRange } from "@/lib/volumeAnalysis";
import { measurementsToMarkers } from "@/lib/measure";
import { tractResultUrl } from "@/lib/tractDissection";
import {
  computeVoxelCounts, unionCounts, affectedSet, mergeRanges,
  classifyHemifield, buildSummary,
  computeVoxelCounts2D, unionGrids,
} from "@/lib/retinotopyAnalysis";
import { VisualFieldMap2D, visualFieldMap2DToDataURL, visualFieldMap2DDataURL } from "@/components/VisualFieldMap2D";
import { dicomSeriesDownloadUrl } from "@/lib/dicom";
import {
  WORKSPACE_VERSION, fileToBase64, base64ToFile, saveWorkspace, openWorkspace, saveBinaryFile,
} from "@/lib/workspace";
import { activeToggleCls } from "@/lib/buttonVariants";
import { toast } from "sonner";
import { useBaseVolume } from "@/hooks/useBaseVolume";
import { useTracts } from "@/hooks/useTracts";
import { useQuickOpenFile } from "@/hooks/useQuickOpenFile";
import { DEFAULT_TRACT_RENDER } from "@/lib/gl/tractSettings";
import { TractographySection } from "@/pages/sections/TractographySection";
import { RetinotopySection } from "@/pages/sections/RetinotopySection";
import { BaseVolumeSection } from "@/pages/sections/BaseVolumeSection";
import { LesionMasksSection } from "@/pages/sections/LesionMasksSection";
import { AtlasesSection } from "@/pages/sections/AtlasesSection";
import { ActivationMapsSection } from "@/pages/sections/ActivationMapsSection";
import { ModuleGate } from "@/components/ModuleGate";
import { ModuleStore } from "@/components/ModuleStore";
const AtlasManager = lazyWithRetry(() => import("@/components/AtlasManager"));
import { useModules } from "@/hooks/use-modules";

const SLICE_MODES = [
  { id: "multiplanar", label: "Multiplanar + 3D", icon: LayoutGrid },
  { id: "render", label: "3D Render", icon: Box },
  { id: "axial", label: "Axial", icon: Activity },
  { id: "coronal", label: "Coronal", icon: Activity },
  { id: "sagittal", label: "Sagittal", icon: Activity },
];

// "red" first so a single lesion mask keeps its long-standing default color
// (SMALL-FIXES item 45 era); subsequent masks cycle through the rest so
// multiple loaded lesions stay visually distinguishable (item 96).
const LESION_CMAP_PALETTE = ["red", "blue", "green", "warm", "cool", "winter"];
const ROI_CMAP_PALETTE = ["green", "blue", "winter", "plasma", "viridis", "warm"];
// "jet" first so the FIRST activation map loaded gets it (SMALL-FIXES 47);
// subsequent maps cycle through the rest. Diverging-only (item 96) — no
// clearly-sequential single-hue maps (hot/inferno/actc), since activation
// maps are signed stat data, not intensity.
const ACTIVATION_CMAP_PALETTE = ["jet", "warm", "cool", "turbo", "plasma", "viridis"];
// TRACT_RGB_PALETTE / MESH_EXTS / TRACT_CLIENT_MAX_BYTES moved to hooks/useTracts.js.

// Pseudo-layer id for the in-progress scratch drawing, so it can be picked for
// the retinotopy deficit analysis without first being saved as a lesion layer.
// Deliberately not a valid niivue volume id: every lookup routes it to
// getDrawingAsVolume() instead of getVolume(), and a real layer can never
// collide with it.
const DRAWING_LESION_ID = "__drawing__";

export default function Dashboard() {
  const { theme, toggleTheme, setTheme } = useTheme();
  // Module store entry point. `ok !== true` means the backend never answered —
  // the "modules absent" dot must NOT light up in that case (see ModuleGate).
  const { openStore, modules: manifestModules, ok: modulesOk } = useModules();
  const modulesAbsent = modulesOk === true
    && manifestModules.some((m) => (m.type || "data") === "data" && !m.installed);
  const viewerRef = useRef(null);
  const bensonVfMap2dRef = useRef(null);
  const wmVfMap2dRef = useRef(null);
  const [viewerReady, setViewerReady] = useState(false);
  // Panel chrome: collapsing hides the sidebar/topbar visually (width/height
  // squeezed to 0 via CSS) but keeps their contents mounted, so section
  // open/closed state and in-progress panel inputs (measurements, drawing,
  // etc.) survive a collapse/expand cycle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [topbarCollapsed, setTopbarCollapsed] = useState(false);
  // Controlled open/closed state for the two sections the mask-edit workflow
  // drives programmatically (handleUserEdit closes Load-Mask and opens Draw).
  // Every other SidebarSection stays uncontrolled via defaultOpen.
  const [lesionSectionOpen, setLesionSectionOpen] = useState(false);
  const [drawingSectionOpen, setDrawingSectionOpen] = useState(false);
  const [tractDissectSectionOpen, setTractDissectSectionOpen] = useState(false);
  const [tractSectionOpen, setTractSectionOpen] = useState(false);
  const [tractAutoExpandId, setTractAutoExpandId] = useState(null);
  const [lnmSectionOpen, setLnmSectionOpen] = useState(false);
  const [activationSectionOpen, setActivationSectionOpen] = useState(false);
  const [activationAutoExpandId, setActivationAutoExpandId] = useState(null);

  const scrollSectionIntoView = (testId) => {
    requestAnimationFrame(() => {
      document.querySelector(`[data-testid="${testId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  // Item 105: "toggle all sections" registry — every SidebarSection under the
  // provider below self-registers, so the header button can both read how many
  // are open and drive all of them at once (works for the uncontrolled ones and
  // the two controlled ones above alike). See components/SidebarSection.jsx.
  const {
    ctx: sidebarSectionsCtx,
    openCount: openSectionCount,
    setAll: setAllSectionsOpen,
  } = useSidebarSectionsController();
  // Focus/presentation mode hides sidebar + topbar + info/status bars at once,
  // restoring the previous collapse state on exit.
  const [focusMode, setFocusMode] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Viewer view state (pushed to NiiVue via effects below; persisted to workspace).
  const [radiological, setRadiological] = useState(true);
  const [orientationLabels, setOrientationLabels] = useState(true);
  // Right-drag mode toggle: "zoom" (default) | "windowing" | "pan". Left-click
  // is ALWAYS crosshair (when not drawing) and isn't controlled by this state
  // anymore — see NiivueViewer's setDragMode, which now configures the RIGHT
  // mouse button only. (Kept the variable name "dragMode" for continuity with
  // the workspace-save format and existing call sites — only its target
  // button and default value changed.)
  const [dragMode, setDragMode] = useState("zoom"); // zoom | windowing | pan
  // Measurements (distance/angle list) + midline landmark. Owned here so they
  // survive the Measurements section collapsing and can be persisted.
  const [measurements, setMeasurements] = useState([]);
  const [landmark, setLandmark] = useState(null);
  // Crosshair "pins": labeled probe points that snapshot the value at that
  // voxel across every visible layer at the moment they're dropped.
  const [pins, setPins] = useState([]);
  // Bumped by Clear All so result-holding panels (Create ROI, Lesion Network
  // Mapping) can reset their own local cards — the viewer removes their overlay
  // volumes but doesn't own their panel state.
  const [clearNonce, setClearNonce] = useState(0);
  // Set by the "D" shortcut, consumed once by DrawingPanel (see its prop docs).
  const [drawTogglePending, setDrawTogglePending] = useState(false);
  // Item 5: name to prefill Draw Mask's save-name box with when handleUserEdit
  // re-opens a saved lesion for editing. editNonce bumps on every Edit click
  // (even re-editing the same name) so DrawingPanel's effect re-fires.
  const [editingSaveName, setEditingSaveName] = useState("");
  const [editNonce, setEditNonce] = useState(0);
  const [sliceType, setSliceType] = useState("multiplanar");
  // Drawing tool state — lifted here from DrawingPanel so Dashboard can show
  // the 4th erase button in the topbar and pass the canvas label to NiivueViewer.
  const [drawingActive, setDrawingActive] = useState(false);
  const [activeTool, setActiveTool] = useState("pen"); // "pen" | "brush"
  // Brush mode: "3D" for multiplanar/asymmetric (default), "2D" for single
  // slice views (axial/coronal/sagittal). Auto-switches when sliceType changes;
  // the user can also override it manually via DrawingPanel's 2D/3D toggle.
  const [brushMode, setBrushMode] = useState("3D");
  const [crosshair, setCrosshair] = useState(true);
  const [crosshairWidth, setCrosshairWidth] = useState(1);
  const [crosshairColor, setCrosshairColor] = useState("white");
  const [showCrosshairSettings, setShowCrosshairSettings] = useState(false);
  const [showClipSettings, setShowClipSettings] = useState(false);
  const crosshairSettingsRef = useRef(null);
  const clipSettingsRef = useRef(null);
  useClickOutside(crosshairSettingsRef, () => setShowCrosshairSettings(false), showCrosshairSettings);
  // Item 102 (6e): don't auto-close the clip popover for a right-click/
  // right-drag on the 3D render tile — that gesture rotates the camera (6c)
  // and the whole point is to watch the az/el sliders track it live (6d)
  // while the popover stays open. The crosshair popover above keeps the
  // original unconditional auto-close. canvasWrapperRef/viewerRef are refs
  // (stable identity, declared elsewhere in this component) read only when
  // this callback actually runs — safe regardless of their declaration
  // order relative to this line.
  const clipPopoverShouldIgnore = useCallback((e) => {
    if (e.button !== 2) return false;
    const el = canvasWrapperRef.current;
    if (!el || !el.contains(e.target)) return false;
    const nv = viewerRef.current?.getNiivue?.();
    if (!nv) return false;
    const rect = el.getBoundingClientRect();
    const dpr = nv.uiData?.dpr || window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    try { return nv.inRenderTile(x, y) !== -1; } catch (_e) { return false; }
  }, []);
  useClickOutside(clipSettingsRef, () => setShowClipSettings(false), showClipSettings, clipPopoverShouldIgnore);
  // Item 102 (6a): clipEnabled owns on/off; clipDepth is now a pure -0.6..0.6
  // value with no "off" sentinel encoded in it, so depth/az/el keep their
  // values across an on/off toggle (previously 0.6 meant "off" AND "max
  // depth" simultaneously, which couldn't preserve a depth setting once
  // disengaged).
  const [clipEnabled, setClipEnabled] = useState(false);
  // Global tractography
  // render controls (geometry/lighting/thickness/slab/display-fraction),
  // pushed to the viewer below via setTractRenderOptions — a uniform-only
  // patch that never rebuilds a buffer.
  const [tractRender, setTractRender] = useState(DEFAULT_TRACT_RENDER);
  const [clipDepth, setClipDepth] = useState(0);
  const [clipAz, setClipAz] = useState(0);
  const [clipEl, setClipEl] = useState(0);
  const [baseLabel, setBaseLabel] = useState(BASE_VOLUME.name);
  // Desktop-only full path of a custom base image (item 13's hover tooltip);
  // null for the bundled MNI152 template and in the browser build, where no
  // real filesystem path is obtainable from a File object.
  const [baseFullPath, setBaseFullPath] = useState(null);
  // 4D frame stepper state — { frame, nFrames }. nFrames stays 1 for a plain
  // 3D base volume, which is what keeps FrameStepper (and the ArrowLeft/
  // ArrowRight capture-phase claim below) inert for the common case.
  const [frameInfo, setFrameInfo] = useState({ frame: 0, nFrames: 1 });
  // Live mirror of baseLabel for the (empty-deps) keyboard-shortcuts map.
  const baseLabelRef = useRef(baseLabel);
  useEffect(() => { baseLabelRef.current = baseLabel; }, [baseLabel]);
  // Live mirror of sliceType for the (empty-deps) keyboard-shortcuts map.
  const sliceTypeRef = useRef("multiplanar");
  useEffect(() => { sliceTypeRef.current = sliceType; }, [sliceType]);
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
  // Refs mirror asymmetric/largeSlice for the empty-deps `shortcuts` memo, which
  // captures state at first render and must read live values via refs.
  const asymmetricRef = useRef(false);
  useEffect(() => { asymmetricRef.current = asymmetric; }, [asymmetric]);
  const largeSliceRef = useRef("axial");
  useEffect(() => { largeSliceRef.current = largeSlice; }, [largeSlice]);

  // Overlay metadata cache: id → {globalMin, globalMax, calMin, calMax, hasZeroVoxels, ignoreZeroVoxels}
  // Populated whenever an overlay is loaded / its thresholds change. Used to drive
  // the per-layer threshold UI and the ColorBarStack on the viewer.
  const [overlayMeta, setOverlayMeta] = useState({});

  // Ref attached to the canvas wrapper div for the non-passive wheel listener.
  // Plain scroll = slice navigation (NiiVue native); Ctrl+scroll = zoom.
  const canvasWrapperRef = useRef(null);

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
  // Bumps on every draw-bitmap mutation, so the retinotopy analysis re-reads the
  // live scratch drawing (same sentinel role retAtlasTick plays for atlases).
  // Only bumped while the drawing is actually selected for analysis — otherwise
  // every brush stroke would re-run the full voxel loop for the real lesions too.
  const [drawVersion, setDrawVersion] = useState(0);
  const [lesionPickerOpen, setLesionPickerOpen] = useState(false);
  const [bensonViewMode, setBensonViewMode] = useState("2d");
  const [wmInlineViewMode, setWmInlineViewMode] = useState("2d");

  // ===== Standard atlases (from the registry) =====
  const { atlases: standardAtlases, refresh: refreshAtlases, reorder: reorderAtlases,
          openManager: openAtlasManager } = useAtlases();
  const resolveAtlas = useResolveAtlas();
  const { regions: atlasRegions, ensure: ensureAtlasRegions,
          clear: clearAtlasRegions } = useAtlasRegions();

  // Per-atlas view state. Seeded PER ID as atlases arrive, not once from a
  // constant: the list is dynamic now, so a useMemo(..., []) could never see an
  // atlas installed after mount, and every consumer indexing atlasState[a.id]
  // unguarded would throw on it.
  const [atlasState, setAtlasState] = useState({});
  const initAtlasState = useMemo(() => ({}), []);
  useEffect(() => {
    if (!standardAtlases.length) return;
    setAtlasState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const a of standardAtlases) {
        if (!next[a.id]) {
          next[a.id] = { visible: false, opacity: a.opacity, colormap: a.colormap };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [standardAtlases]);

  // {atlasId: {value: name}} for the two SYNCHRONOUS hot paths below
  // (handleLocationChange runs inside a niivue callback, atlasLabelLookup
  // inside the cluster table's render). Mirrors the reactive `atlasRegions`
  // state through a ref — the pattern CLAUDE.md §6 requires for anything a
  // listener registered at mount has to read.
  // Per-atlas "show only these regions" allow-list: {atlasId: Set<value>}.
  // An empty/absent entry means every region is shown.
  const [atlasIsolate, setAtlasIsolate] = useState({});

  const atlasNamesRef = useRef({});
  useEffect(() => {
    const m = {};
    for (const [id, list] of Object.entries(atlasRegions)) m[id] = toNameMap(list);
    atlasNamesRef.current = m;
  }, [atlasRegions]);

  // User-uploaded layers (lesion / roi / activation / custom-atlas)
  const [userLayers, setUserLayers] = useState([]);
  // {volumeId: displayName} for the crosshair value bar (item 19). niivue names
  // each volume by its layer id (e.g. "lesion-1699…"), so the value bar showed
  // that raw id instead of the layer's real name; this maps it back. A ref, not
  // a dep, because handleLocationChange is a hot niivue callback (CLAUDE.md §6).
  const layerNamesRef = useRef({});
  useEffect(() => {
    const m = {};
    for (const l of userLayers) m[l.id] = l.name;
    layerNamesRef.current = m;
  }, [userLayers]);
  // Free-text notes (item 13), keyed by whatever id the layer/card uses —
  // one flat map shared by every section (base volume's "mni152", standard
  // atlas ids, retinotopy layer ids, and every user-uploaded layer/tract id)
  // since none of those id spaces collide. Session-only: not part of any
  // save/restore payload yet.
  const [layerNotes, setLayerNotes] = useState({});
  const handleNotesChange = (id, text) => setLayerNotes((p) => ({ ...p, [id]: text }));
  const userFileCache = useRef({});
  // Per-type palette cursor for addUserFile's colormap cycling (item 96).
  // MUST be a ref, not derived from userLayers.length: a multi-file upload
  // loop (`for (const f of files) await addUserFile(f, type)`, item 95) awaits
  // addUserFile before the next iteration, but React state doesn't flush
  // synchronously between awaits — every file in one batch would read the same
  // stale userLayers.length and get the SAME colormap. Incremented
  // synchronously inside addUserFile instead.
  const cmapCursor = useRef({ lesion: 0, activation: 0, roi: 0 });

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

  const labelsDebounceRef = useRef(null);

  // Tracks which 2D view (axCorSag: 0=axial, 1=coronal, 2=sagittal) the user
  // last clicked or scrolled in, for orientation-aware arrow-key slice
  // stepping in Multi/Asymmetric layouts (single-view modes use the view
  // itself instead — see the shortcuts below). Defaults to axial. Mirrored
  // into state (only on actual change, not every event) so the active tile
  // can be highlighted without re-rendering on every scroll tick.
  const lastOrientationRef = useRef(0);
  const [activeOrientation, setActiveOrientation] = useState(0);

  // Threshold-slider histograms, computed lazily per layer id (full-volume
  // scan) the first time that layer's advanced panel is expanded.
  const [histograms, setHistograms] = useState({});
  const requestHistogram = useCallback((layerId) => {
    setHistograms((prev) => {
      if (prev[layerId]) return prev;
      const h = viewerRef.current?.getOverlayHistogram(layerId);
      return h ? { ...prev, [layerId]: h } : prev;
    });
  }, []);

  // Live "N voxels / X.XX mL visible" readout next to a layer's threshold
  // slider. Debounced (full-volume scan) so dragging the slider doesn't
  // trigger a scan on every tick — only once the drag settles.
  const [thresholdVolumes, setThresholdVolumes] = useState({});
  const thresholdVolumeTimers = useRef({});
  const scheduleThresholdVolume = useCallback((id, lo, hi, invert) => {
    clearTimeout(thresholdVolumeTimers.current[id]);
    thresholdVolumeTimers.current[id] = setTimeout(() => {
      const stats = viewerRef.current?.getOverlayThresholdVolume(id, lo, hi, invert);
      if (stats) setThresholdVolumes((prev) => ({ ...prev, [id]: stats }));
    }, 250);
  }, []);

  // ===== Location change → labels + voxel values =====
  const handleLocationChange = useCallback((data) => {
    if (!data) return;
    if (data.mm) setCrosshairMM([data.mm[0], data.mm[1], data.mm[2]]);
    if (data.vox) setCrosshairVox([data.vox[0], data.vox[1], data.vox[2]]);
    if (Number.isFinite(data.axCorSag) && data.axCorSag >= 0 && data.axCorSag <= 2) {
      if (lastOrientationRef.current !== data.axCorSag) {
        lastOrientationRef.current = data.axCorSag;
        setActiveOrientation(data.axCorSag);
      }
    }

    // niivue reports each volume's name as the URL basename (e.g.
    // 'benson14_polar_angle'). Map that back to the layer id we registered.
    //
    // Atlases resolve through the registry rather than the hand-written regex
    // this used to carry: that regex listed four ids and silently failed for
    // hcp1065, so the crosshair bar never named a white-matter tract. The
    // retinotopy layers keep their explicit mapping — they are not atlases and
    // are not in the registry.
    const canon = (rawName) => {
      if (!rawName) return rawName;
      if (rawName.includes("wang2015_maxprob")) return "wang2015_maxprob";
      if (rawName.includes("benson14_polar_angle")) return "benson_polar_angle";
      if (rawName.includes("benson14_eccentricity")) return "benson_eccentricity";
      if (rawName.includes("benson14_visual_areas")) return "benson_visual_areas";
      return resolveAtlas(rawName)?.id || rawName;
    };
    const labels = {};
    const values = data.values || [];
    const valueRows = [];

    // Item 19: the value bar showed a row for EVERY loaded volume, including
    // the retinotopy helper maps (benson/wm polar-angle + eccentricity) that
    // are auto-loaded invisibly at opacity 0 the moment a lesion exists — they
    // appeared as PolarAng0 / Eccen0 / wm_… noise. Skip any volume that is not
    // actually visible (opacity 0), keyed by the live niivue opacity so the
    // rule is uniform across user layers, atlases and retinotopy.
    const nv = viewerRef.current?.getNiivue();
    const opacityByName = {};
    if (nv?.volumes) for (const vol of nv.volumes) opacityByName[vol.name] = vol.opacity;

    // Friendly name for a value row: a user layer shows its sidebar name (not
    // the raw "lesion-<timestamp>" id), an atlas its short name, the fixed
    // helpers their labels.
    const RETINO_SHORT = {
      mni152: "MNI152", wang2015_maxprob: "Wang",
      benson_polar_angle: "PolarAng", benson_eccentricity: "Eccen",
      benson_visual_areas: "VArea", wm_polar_angle: "WM PolarAng",
      wm_eccentricity: "WM Eccen",
    };
    const readoutName = (rawName, canonName) => {
      const ln = layerNamesRef.current[rawName] || layerNamesRef.current[canonName];
      if (ln) return ln;
      const atlas = resolveAtlas(canonName);
      if (atlas) return atlas.short || atlas.id;
      return RETINO_SHORT[canonName] || shortLayerName(canonName);
    };

    for (const v of values) {
      const name = canon(v.name);
      const k = Math.round(v.value);
      if (k > 0) {
        if (name === "wang2015_maxprob" && WANG_LABELS[k]) labels["Wang ROI"] = WANG_LABELS[k];
        else if (name === "benson_visual_areas" && VAREA_LABELS[k]) labels["Visual Area"] = VAREA_LABELS[k];
        else if (atlasNamesRef.current[name]) {
          const tbl = atlasNamesRef.current[name];
          if (tbl[k]) labels[shortAtlas(name, resolveAtlas)] = tbl[k];
        }
      }
      // Build a numeric value row only for volumes the user can actually see.
      // Hidden-label helpers (suffix "__labels") and opacity-0 helpers are
      // skipped; the base volume (opacity undefined here only if unset) stays.
      const opacity = opacityByName[v.name];
      const visible = opacity === undefined || opacity > 0;
      if (typeof v.value === "number" && visible && !String(name || "").endsWith("__labels")) {
        valueRows.push({ name: readoutName(v.name, name), value: v.value });
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
      const tbl = atlasNamesRef.current[resolveAtlas(atlasId)?.id || atlasId];
      if (tbl?.[k]) {
        extra[`${readoutName(layerId, layerId)}↦${shortAtlas(atlasId, resolveAtlas)}`] = tbl[k];
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
  }, [layerLabelAtlas, resolveAtlas]);

  // Atlas lookup function for cluster table (returns region name at a peak voxel)
  const atlasLabelLookup = useCallback((peakVox) => {
    const nv = viewerRef.current?.getNiivue();
    if (!nv) return null;
    // pick first visible standard atlas
    for (const a of standardAtlases) {
      if (!atlasState[a.id]?.visible) continue;
      const vol = nv.volumes.find((v) => v?.name === a.id);
      if (!vol?.img || !vol?.dims) continue;
      const [, nx, ny] = vol.dims;
      const [i, j, k] = peakVox.map((n) => Math.round(n));
      const idx = i + nx * (j + ny * k);
      const val = Math.round(vol.img[idx] || 0);
      const labels = atlasNamesRef.current[a.id];
      if (labels?.[val]) return `${a.short || a.id}: ${labels[val]}`;
    }
    return null;
  }, [atlasState, standardAtlases]);

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
  };
  const handleRetColormap = (id, cm) => {
    setRetState((p) => ({ ...p, [id]: { ...p[id], colormap: cm } }));
    viewerRef.current?.setOverlayColormap(id, cm);
  };

  // ===== Standard atlases handlers =====
  // Label fetching + normalisation now lives in useAtlasRegions/lib/atlasLabels;
  // this file no longer knows what shape a label file has.

  const handleAtlasToggle = async (id) => {
    const cfg = resolveAtlas(id);
    const viewer = viewerRef.current;
    if (!cfg || !viewer) return;
    const s = atlasState[cfg.id] || { opacity: cfg.opacity, colormap: cfg.colormap };
    if (s.visible) {
      viewer.removeOverlayByName(cfg.id);
      setAtlasState((p) => ({ ...p, [cfg.id]: { ...p[cfg.id], visible: false } }));
    } else {
      const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: s.opacity, colormap: s.colormap });
      if (vol) {
        await ensureAtlasRegions(cfg);
        setAtlasState((p) => ({
          ...p,
          [cfg.id]: { ...(p[cfg.id] || { opacity: cfg.opacity, colormap: cfg.colormap }), visible: true },
        }));
        refreshOverlayMeta(cfg.id);
        toast.success(`${cfg.name} loaded`);
        // visfAtlas ROIs sit on higher visual cortex (ventral occipital-temporal
        // and lateral occipital). Default crosshair at brain centre never
        // intersects them — auto-jump so the user can immediately see colour.
        if (cfg.id === "visfatlas" && VISFATLAS_NAV_MM) {
          viewer.setCrosshairMM?.(...VISFATLAS_NAV_MM);
        }
      }
    }
  };
  const handleAtlasOpacity = (id, v) => {
    setAtlasState((p) => ({ ...p, [id]: { ...p[id], opacity: v } }));
    viewerRef.current?.setOverlayOpacity(id, v);
  };
  const handleAtlasColormap = (id, cm) => {
    setAtlasState((p) => ({ ...p, [id]: { ...p[id], colormap: cm } }));
    viewerRef.current?.setOverlayColormap(id, cm);
  };
  // Show only the chosen regions of an atlas. Implemented as a colormap-label
  // alpha mask rather than by editing voxels, so it is instant and reversible
  // and never touches the atlas on disk.
  const handleAtlasIsolate = (atlasId, values) => {
    const cfg = resolveAtlas(atlasId);
    if (!cfg) return;
    const set = values && values.length ? new Set(values) : null;
    setAtlasIsolate((p) => {
      const next = { ...p };
      if (set) next[cfg.id] = set;
      else delete next[cfg.id];
      return next;
    });
    viewerRef.current?.setOverlayLabelFilter?.(cfg.id, set ? [...set] : null);
  };

  // Persist per-region colours onto the atlas's own label file, so a colour
  // scheme travels with the atlas folder instead of living in app state.
  const handleAtlasRegionColors = async (atlasId, colors) => {
    const cfg = resolveAtlas(atlasId);
    if (!cfg) return;
    try {
      await patchAtlas(cfg.id, { colors });
      clearAtlasRegions(cfg.id);
      const fresh = await ensureAtlasRegions(cfg);
      viewerRef.current?.setOverlayLabelColors?.(cfg.id, fresh);
    } catch (e) {
      toast.error("Could not save that colour", { description: e?.message });
    }
  };

  // Clip an atlas out of the 3D clip-plane grouping (SMALL-PROBLEMS 18). The
  // per-overlay clip plumbing is generic by id, so this is the user-layer
  // handler applied to an atlas — no new logic.
  const handleAtlasClipChange = (id, clipOn) => handleUserClipChange(id, clipOn);

  // Jump the crosshair to an atlas region's center (label-list navigate button).
  const handleAtlasNavigate = async (atlasId, labelValue) => {
    const cfg = resolveAtlas(atlasId);
    if (!cfg) return;
    // Prefer the centroid the registry already computed at install time (it is
    // snapped onto an in-region voxel, so a bilateral single-label region lands
    // ON itself instead of on the midline). Falls back to the client-side scan
    // for an atlas whose labels predate that.
    const seeded = (atlasRegions[cfg.id] || []).find((r) => r.value === labelValue)?.centroidMM;
    const mm = seeded || viewerRef.current?.getAtlasRegionCentroidMM?.(cfg.id, labelValue);
    if (mm) viewerRef.current?.setCrosshairMM?.(...mm);
    else toast.info("That region has no voxels in the loaded atlas");
  };

  // Turn selected atlas regions into a mask layer (Region -> ROI).
  const handleAtlasRegionMask = async (atlasId, values, label) => {
    const cfg = resolveAtlas(atlasId);
    if (!cfg || !values?.length) return;
    try {
      const res = await regionMask(cfg.id, values, label);
      const r = await fetch(res.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const file = new File([blob], res.filename, { type: "application/gzip" });
      await addUserFile(file, "roi");
      toast.success(`${res.regions.length} region(s) added as an ROI layer`);
    } catch (e) {
      toast.error("Could not build that region mask", { description: e?.message });
    }
  };

  // ===== Generic user-uploaded layer add (volume) =====
  const addUserFile = async (file, type, opts = {}) => {
    const viewer = viewerRef.current;
    if (!viewer) return null;
    const id = `${type}-${Date.now()}`;
    // Palette cycling (item 96) — cmapCursor is a ref incremented synchronously
    // here (not derived from userLayers.length) so a multi-file upload loop
    // (item 95) gives each file in the SAME batch a different colormap; see the
    // cmapCursor declaration above for why state-derived counting breaks that.
    const nextCmap = (palette, key) => {
      const idx = cmapCursor.current[key] % palette.length;
      cmapCursor.current[key] += 1;
      return palette[idx];
    };
    const cm =
      opts.colormap ||
      (type === "lesion" ? nextCmap(LESION_CMAP_PALETTE, "lesion")
        : type === "activation" ? nextCmap(ACTIVATION_CMAP_PALETTE, "activation")
        : type === "atlas" ? "random"
        : nextCmap(ROI_CMAP_PALETTE, "roi"));
    const opacity = opts.opacity ?? (type === "lesion" ? 0.85 : 0.8);
    const vol = await viewer.addOverlayFromFile(file, {
      colormap: cm, opacity, name: id,
      // Drives the per-type defaults in the viewer: the activation threshold
      // defaults (49) and the initial "mask zero voxels" toggle state — on for
      // lesion/ROI masks so their zero background can't veil the base scan (45),
      // off for activation maps so zeros follow the threshold logic (48).
      overlayKind: type,
    });
    if (!vol) return null;
    userFileCache.current[id] = { file, colormap: cm };
    // Activation maps omit the type prefix — the section header already says "Activation Maps"
    const layerName = type === "activation" ? file.name : `${typeLabel(type)} · ${file.name}`;
    setUserLayers((p) => [
      ...p,
      { id, name: opts.name || layerName, type, visible: true, opacity, colormap: cm,
        clip: type !== "lesion" && type !== "activation",
        description: `${(file.size / 1024).toFixed(1)} KB`,
        // Desktop-only (Electron's webUtils.getPathForFile via preload) — a
        // plain browser <input type=file> cannot expose a real filesystem
        // path, so this stays null there and the hover tooltip falls back
        // to the layer name.
        fullPath: window.mrlatte?.getPathForFile?.(file) || null },
    ]);
    refreshOverlayMeta(id);
    toast.success(`${typeLabel(type)} loaded`, { description: file.name });
    return id; // the new layer id, so callers (workspace restore) can post-configure it
  };

  // "Save" Lesion Network Map → Activation Maps (item 59) — thin wrapper over
  // addUserFile so the network map gets full threshold/colormap controls
  // instead of the panel's own ad-hoc overlay.
  const handleSaveLnmActivation = (file, name) => addUserFile(file, "activation", { name });

  const handleUserToggle = (id) => {
    const layer = userLayers.find((l) => l.id === id);
    const viewer = viewerRef.current;
    if (!layer || !viewer) return;
    if (layer.visible) {
      // Zero the opacity rather than removing the volume. This preserves all
      // runtime state on the NiiVue NVImage object: __maskZero,
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
  };
  const handleUserColormap = (id, cm) => {
    setUserLayers((p) => p.map((l) => (l.id === id ? { ...l, colormap: cm } : l)));
    viewerRef.current?.setOverlayColormap(id, cm);
  };
  // Colormap-direction invert (item 55) — mirrors handleUserColormap. Only
  // wired to activation-map layers (see UserLayerList below); the viewer
  // method is a no-op for base volume / categorical atlases regardless.
  const handleUserColormapInvert = (id, on) => {
    viewerRef.current?.setColormapInverted?.(id, on);
    setOverlayMeta((p) => ({
      ...p,
      [id]: { ...(p[id] || {}), colormapInverted: on },
    }));
  };
  const handleUserClipChange = (id, clipOn) => {
    viewerRef.current?.setOverlayClip?.(id, clipOn);
    setOverlayMeta((p) => ({
      ...p,
      [id]: { ...(p[id] || {}), clip: clipOn },
    }));
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

  // Explicit per-object download of a saved/loaded mask (item 39: download is
  // separate from save). Uses the cached File; no re-encode.
  const handleUserDownload = async (id) => {
    const cached = userFileCache.current[id];
    if (!cached?.file) { toast.error("No downloadable file for this layer"); return; }
    try {
      const buf = new Uint8Array(await cached.file.arrayBuffer());
      await saveBinaryFile(cached.file.name || `${id}.nii.gz`, cached.file.type || "application/gzip", buf);
    } catch (e) {
      toast.error("Download failed", { description: e?.message });
    }
  };

  // Re-open a saved/loaded mask in the editable drawing (item 39: saved objects
  // are re-editable). Loads its file into nv.drawBitmap via the item-37 path.
  const handleUserEdit = async (id) => {
    const cached = userFileCache.current[id];
    if (!cached?.file) { toast.error("No editable file for this layer"); return; }
    const layer = userLayers.find((l) => l.id === id);
    viewerRef.current?.drawClear?.();
    const ok = await viewerRef.current?.loadDrawingFromVolume?.(cached.file);
    if (!ok) return;
    // Fully unload the source layer rather than just hiding it (item 5): Save
    // always creates a NEW layer, so leaving the original around — even
    // invisible — meant editing then saving left both the old and new file.
    handleUserRemove(id);
    // Prefill the save-name box with the original name so pressing Save again
    // reuses it by default (still editable) instead of minting a new name.
    setEditingSaveName(layer?.name || "");
    setEditNonce((n) => n + 1);
    // Collapse Load-Mask, expand Draw, and make sure paint mode is on. Opening
    // the Draw section mounts DrawingPanel, which mirrors the viewer's paint
    // state on subscribe (setDrawingActiveCallback) → shows "Drawing · Active".
    setLesionSectionOpen(false);
    setDrawingSectionOpen(true);
    viewerRef.current?.setDrawingEnabled?.(true);
    toast.success("Loaded into Draw Mask — edit it there");
  };

  // Clone a saved mask as a brand-new layer, named "Copy of {original}" (item
  // 5). Reuses the cached File — no re-draw, no touching the original.
  const handleUserDuplicate = async (id) => {
    const cached = userFileCache.current[id];
    if (!cached?.file) { toast.error("No duplicable file for this layer"); return; }
    const layer = userLayers.find((l) => l.id === id);
    await addUserFile(cached.file, layer?.type || "lesion", { name: `Copy of ${layer?.name || id}` });
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
    scheduleThresholdVolume(id, cal_min, cal_max, overlayMeta[id]?.invertThreshold);
  };
  // mrview-style colour-scaling range, independent of the visibility window.
  const handleColorRangeChange = (id, color_min, color_max) => {
    viewerRef.current?.setOverlayColorRange(id, color_min, color_max);
    setOverlayMeta((p) => ({
      ...p,
      [id]: { ...(p[id] || {}), color_min, color_max },
    }));
  };
  // One-click auto-contrast: snap an overlay's colour range to its robust
  // 2–98th-percentile intensity window.
  const handleAutoColorRange = (id) => {
    const v = viewerRef.current?.getVolume?.(id);
    const r = robustRange(v);
    if (!r) return toast.error("Auto-contrast unavailable for this layer");
    handleColorRangeChange(id, r[0], r[1]);
  };
  // Same idea as handleAutoColorRange, but for the VISIBILITY threshold
  // instead of the colour-scaling range — snaps to the robust 2-98th
  // percentile window so background/outlier voxels drop out of view.
  const handleAutoThreshold = (id) => {
    const v = viewerRef.current?.getVolume?.(id);
    const r = robustRange(v);
    if (!r) return toast.error("Auto-threshold unavailable for this layer");
    handleCalRangeChange(id, r[0], r[1]);
  };
  // Base-volume window presets.
  const handleBaseAutoWindow = () => {
    const v = viewerRef.current?.getBaseVolume?.();
    const r = robustRange(v);
    if (!r) return toast.error("Auto-contrast unavailable");
    handleBaseCalRange(null, r[0], r[1]);
  };
  const handleBaseFullWindow = () => {
    const range = viewerRef.current?.getBaseRange?.();
    if (!range) return;
    handleBaseCalRange(null, range.global_min, range.global_max);
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
    scheduleThresholdVolume(id, overlayMeta[id]?.cal_min, overlayMeta[id]?.cal_max, on);
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
  // atlas NVImage, or null. Shared by the label-atlas picker and the lesion
  // report.
  const ensureAtlasLoaded = useCallback(async (atlasId, { silent = false } = {}) => {
    if (!atlasId) return null;
    const viewer = viewerRef.current;
    const nv = viewer?.getNiivue();
    if (!viewer || !nv) return null;
    const cfg = resolveAtlas(atlasId);
    if (!cfg) return null;
    const existing = nv.volumes?.find((v) => v?.name === cfg.id);
    if (existing) {
      await ensureAtlasRegions(cfg);
      return existing;
    }
    const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: 0 });
    if (vol) {
      await ensureAtlasRegions(cfg);
      setAtlasState((p) => ({
        ...p,
        [cfg.id]: { ...(p[cfg.id] || { colormap: cfg.colormap }), visible: false, opacity: 0 },
      }));
      if (!silent) toast.success(`${cfg.short} loaded for label lookup`);
    }
    return vol;
  }, [resolveAtlas, ensureAtlasRegions]);

  // Retinotopy layers whose speculative preload already failed — see the guard
  // in ensureRetinotopyLoaded below. A ref, not state: nothing renders from it.
  const failedRetinotopyRef = useRef(new Set());

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
    // A speculative preload that already failed is not going to start working:
    // the WM maps ship with an optional module, so on a core install they 404
    // every time. The preload effect re-fires whenever a lesion appears or
    // disappears — and the scratch drawing makes that happen constantly — so
    // without this the app re-requests a known-absent file on every edit.
    // Only speculative loads are remembered; an explicit user-initiated load
    // still retries (the module may have been installed since).
    if (silent && failedRetinotopyRef.current.has(layerId)) return null;
    // `silent` covers failure as well as success: toasting about an optional
    // module the user never asked for is noise.
    const vol = await viewer.addOverlayFromUrl({ ...cfg, opacity: 0, quiet: silent });
    if (vol) {
      failedRetinotopyRef.current.delete(layerId);
      setRetState((p) => ({ ...p, [layerId]: { ...p[layerId], visible: false, opacity: 0 } }));
      setRetAtlasTick((t) => t + 1);
      if (!silent) toast.success(`${cfg.name} loaded for overlap lookup`);
    } else if (silent) {
      failedRetinotopyRef.current.add(layerId);
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

  // Base-volume handlers (hooks/useBaseVolume.js) + tract/mesh handlers
  // (hooks/useTracts.js). Same local names as before extraction.
  const {
    handleBaseUpload, baseLoading, markBaseLoadedExternally, handleDicomImport, loadDicomSeries, handleResetBase,
    handleBaseVisibilityToggle, handleBaseOpacity, handleBaseColormap,
    handleBaseCalRange, handleBaseColorbarToggle, refreshBaseOverlayMeta,
  } = useBaseVolume({
    viewerRef, baseVisible, setBaseLabel, setBaseVisible, setBaseOpacity,
    setBaseColormap, setBaseColorbarOn, setBaseOverlayMeta, setDicomJob,
    setDicomProgress, setDicomDownload, setLoadedSeriesId, setBaseFullPath,
  });
  const {
    handleTractUpload, handleTractColorMode, handleTractSolidColor, handleTractOpacity,
    handleTractRemove, buildTractReportModelFor, handleSaveTract,
    handleTractRenderChange, handleTractVisible, handleTractClip,
  } = useTracts({
    viewerRef, tractLayers, setTractLayers, setTractLoading,
    setTractLoadError, tractDirectionMap, tractRender, setTractRender,
  });

  // ===== 4D frame stepper =====
  // Re-seed whenever the base volume changes (new upload, reset, or a quick-
  // open route) rather than touching useBaseVolume.js itself — a 3D base
  // resets nFrames back to 1, which is what keeps the stepper hidden again.
  useEffect(() => {
    const info = viewerRef.current?.getFrameInfo?.();
    if (info) setFrameInfo(info);
  }, [baseLabel]);
  const handleFrameChange = useCallback((frame, nFrames) => {
    setFrameInfo({ frame, nFrames });
  }, []);
  const stepFrame = useCallback((dir) => {
    const frame = viewerRef.current?.stepFrame?.(dir);
    if (typeof frame === "number") setFrameInfo((p) => ({ ...p, frame }));
  }, []);
  const setFrame = useCallback((i) => {
    const frame = viewerRef.current?.setFrame?.(i);
    if (typeof frame === "number") setFrameInfo((p) => ({ ...p, frame }));
  }, []);

  // Simulated base-volume loading progress bar. niivue's loader exposes no
  // byte/percent progress hook (checked — nothing like onProgress in its
  // source), so this can't be a real percentage; it climbs toward 90% over a
  // plausible duration and snaps to 100% on actual completion, same pattern
  // SplashScreen already uses for the app's own boot progress.
  const [loadBarPct, setLoadBarPct] = useState(0);
  const [loadBarVisible, setLoadBarVisible] = useState(false);
  const wasBaseLoadingRef = useRef(false);
  useEffect(() => {
    if (baseLoading) {
      wasBaseLoadingRef.current = true;
      setLoadBarVisible(true);
      setLoadBarPct(0);
      const start = Date.now();
      const CLIMB_MS = 5000;
      let raf;
      const tick = () => {
        const pct = Math.min(90, ((Date.now() - start) / CLIMB_MS) * 90);
        setLoadBarPct(pct);
        if (pct < 90) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    if (wasBaseLoadingRef.current) {
      wasBaseLoadingRef.current = false;
      setLoadBarPct(100);
      const t = setTimeout(() => setLoadBarVisible(false), 220);
      return () => clearTimeout(t);
    }
  }, [baseLoading]);

  // Timeseries graph data: intensity at the crosshair voxel across every
  // frame. Depends on crosshairVox (recompute on crosshair move) and
  // baseLabel (force a recompute on a NEW 4D volume even if the crosshair
  // numerically didn't move) — not on frameInfo.frame, since the series
  // itself doesn't change as you step through it, only which frame is marked.
  const [timeseriesData, setTimeseriesData] = useState(null);
  useEffect(() => {
    if (!(frameInfo.nFrames > 1) || !crosshairVox) { setTimeseriesData(null); return; }
    const [vx, vy, vz] = crosshairVox;
    const values = viewerRef.current?.getTimeseriesAtVoxel?.(Math.round(vx), Math.round(vy), Math.round(vz));
    setTimeseriesData(values || null);
  }, [crosshairVox, frameInfo.nFrames, baseLabel]);

  // Explorer double-click / file-association quick-open (no-op in the
  // browser build, and for any window not opened with a file). Resolves
  // initialBaseVolume BEFORE the viewer ever mounts, so a base/timeseries
  // quick-open loads straight from the double-clicked file — no MNI152
  // fetch-then-swap flash.
  const { initialBaseVolume } = useQuickOpenFile({
    viewerReady, handleBaseUpload, markBaseLoadedExternally, addUserFile, removeUserLayer: handleUserRemove,
    setAsymmetric, setSliceType, setFocusMode,
  });

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
    clearAtlasRegions();
    cmapCursor.current = { lesion: 0, activation: 0, roi: 0 };
    setCrosshairLabels({});
    setCrosshairValues([]);
    setSelectedLesionIds(new Set());
    setLayerLabelAtlas({});
    setLesionPickerOpen(false);
    setMeasurements([]);
    setLandmark(null);
    setClearNonce((n) => n + 1);
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
        sliceType, crosshair, crosshairWidth, crosshairColor, clipEnabled, clipDepth, clipAz, clipEl, asymmetric, largeSlice,
        baseVisible, baseOpacity, baseColormap, baseColorbarOn,
        // Base intensity window + view chrome (v3).
        baseCalMin: baseOverlayMeta.cal_min, baseCalMax: baseOverlayMeta.cal_max,
        sidebarCollapsed, topbarCollapsed, dragMode, radiological, orientationLabels, theme,
        activeOrientation,
        // Global tract
        // render settings (geometry, lighting, thickness, slab, display
        // fraction). Tract *layers* themselves stay unpersisted — only this
        // render-state object is saved, same as clipEnabled above.
        tractRender,
      },
      crosshairMM,
      retState,
      atlasState,
      layerLabelAtlas,
      userLayers: userLayers.map((l) => {
        const m = overlayMeta[l.id] || {};
        return {
          id: l.id, name: l.name, type: l.type, visible: l.visible,
          opacity: l.opacity, colormap: l.colormap,
          // Per-layer threshold (visibility) + colour-scaling ranges (v3).
          calMin: m.cal_min, calMax: m.cal_max,
          colorMin: m.color_min, colorMax: m.color_max,
        };
      }),
      measurements,
      landmark,
      pins,
      files,
    };
  }, [userLayers, overlayMeta, sliceType, crosshair, crosshairWidth, crosshairColor, clipEnabled, clipDepth, clipAz, clipEl,
      asymmetric, largeSlice, baseVisible, baseOpacity, baseColormap, baseColorbarOn, baseOverlayMeta,
      sidebarCollapsed, topbarCollapsed, dragMode, radiological, orientationLabels, theme, activeOrientation,
      measurements, landmark, pins, crosshairMM, retState, atlasState, layerLabelAtlas, baseLabel, tractRender]);

  const applyWorkspace = useCallback(async (ws) => {
    if (!ws || ![1, 2, 3, 4].includes(ws.version)) {
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
    // Item 102 (6a): v.clipEnabled is new (workspaces saved after this
    // change); older files only have clipDepth, where >= 0.6 meant "off" (the
    // previous overloaded sentinel — see the state declarations above).
    if (v.clipEnabled !== undefined) {
      setClipEnabled(!!v.clipEnabled);
      setClipDepth(v.clipDepth ?? 0);
    } else {
      const wasEngaged = v.clipDepth != null && v.clipDepth < 0.6;
      setClipEnabled(wasEngaged);
      setClipDepth(wasEngaged ? v.clipDepth : 0);
    }
    setClipAz(v.clipAz ?? 0);
    setClipEl(v.clipEl ?? 0);
    // v.tractRender is new
    // (workspaces saved after this change); older workspace files lack this
    // key entirely, same "older files lack this key" case as clipEnabled
    // above. Merge over DEFAULT_TRACT_RENDER (rather than replace) so a file
    // saved before a later field existed (e.g. pre-A3 slabEnabled removal)
    // still yields a complete, current-shape object.
    setTractRender({ ...DEFAULT_TRACT_RENDER, ...(v.tractRender || {}) });
    setAsymmetric(!!v.asymmetric);
    if (v.largeSlice) setLargeSlice(v.largeSlice);
    setBaseVisible(v.baseVisible ?? true);
    viewerRef.current?.setBaseVisible(v.baseVisible ?? true);
    if (v.baseOpacity != null) { setBaseOpacity(v.baseOpacity); viewerRef.current?.setBaseOpacity(v.baseOpacity); }
    if (v.baseColormap) { setBaseColormap(v.baseColormap); viewerRef.current?.setBaseColormap(v.baseColormap); }
    if (v.baseColorbarOn != null) { setBaseColorbarOn(!!v.baseColorbarOn); viewerRef.current?.setBaseColorbarVisible(!!v.baseColorbarOn); }
    if (v.baseCalMin != null && v.baseCalMax != null) handleBaseCalRange(null, v.baseCalMin, v.baseCalMax);
    // View chrome (v3): missing on older files → keep current defaults.
    setSidebarCollapsed(!!v.sidebarCollapsed);
    setTopbarCollapsed(!!v.topbarCollapsed);
    if (v.dragMode) setDragMode(v.dragMode);
    setRadiological(!!v.radiological);
    if (v.orientationLabels != null) setOrientationLabels(!!v.orientationLabels);
    if (v.theme === "light" || v.theme === "dark") setTheme(v.theme);
    if (v.activeOrientation != null && v.activeOrientation >= 0 && v.activeOrientation <= 2) {
      lastOrientationRef.current = v.activeOrientation;
      setActiveOrientation(v.activeOrientation);
    }
    // Measurements + midline landmark (v3).
    setMeasurements(Array.isArray(ws.measurements) ? ws.measurements : []);
    setLandmark(ws.landmark || null);
    setPins(Array.isArray(ws.pins) ? ws.pins : []);

    // Re-add user volumes from embedded bytes, then restore per-layer
    // visibility + threshold/colour ranges (a load defaults to visible).
    for (const l of ws.userLayers || []) {
      const f = ws.files?.[l.id];
      if (!f?.b64) continue;
      const file = base64ToFile(f.b64, f.name || `${l.type}.nii.gz`);
      const newId = await addUserFile(file, l.type, { colormap: l.colormap, opacity: l.opacity });
      if (!newId) continue;
      if (typeof l.calMin === "number" && typeof l.calMax === "number") handleCalRangeChange(newId, l.calMin, l.calMax);
      if (typeof l.colorMin === "number" && typeof l.colorMax === "number") handleColorRangeChange(newId, l.colorMin, l.colorMax);
      if (l.visible === false) handleUserToggle(newId);
    }

    // Restore standard atlases that were visible. Saved ids are resolved
    // through the registry's aliases: a workspace written before the atlas
    // revamp holds "ho_cort"/"hcp1065"/"visfAtlas", which are now
    // harvard_oxford_cort/hcp1065_tracts/visfatlas.
    for (const [savedId, s] of Object.entries(ws.atlasState || {})) {
      if (!s?.visible) continue;
      const cfg = resolveAtlas(savedId);
      if (!cfg) continue;          // that atlas has since been uninstalled
      await handleAtlasToggle(cfg.id);
      if (typeof s.opacity === "number") handleAtlasOpacity(cfg.id, s.opacity);
      if (s.colormap) handleAtlasColormap(cfg.id, s.colormap);
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

  // Item 104: right-drag over the 3D render tile rotates the CLIP PLANE (the
  // render camera is niivue's native left-drag and is untouched by this).
  // NiivueViewer emits pixel DELTAS, folded in here with functional setState
  // so the drag always continues from the sliders' current values — that is
  // what makes slider→drag as seamless as drag→slider (previously the drag
  // read the camera as its base and snapped back to the last drag's angles).
  // Both axes wrap over a FULL 360° turn into [-180, 180) so a sustained drag
  // never sticks at an end stop. Elevation gets the same period as azimuth
  // because the plane normal is sph2cartDeg(az + 180, el), which is continuous
  // and 360°-periodic in elevation too — the old -90..90 clamp is exactly what
  // made vertical drags stick at a pole (see the el slider's range below).
  const handleClipRotateDelta = useCallback((dAz, dEl) => {
    setClipAz((prev) => wrapTurn(prev + dAz));
    setClipEl((prev) => wrapTurn(prev + dEl));
  }, []);

  // ===== Side effects =====
  // Item 102 (6a): clipEnabled owns on/off; pass niivue's out-of-volume depth
  // (2) to disengage when off, the real -0.6..0.6 clipDepth value otherwise.
  useEffect(() => {
    const d = clipEnabled ? clipDepth : 2;
    viewerRef.current?.setClipPlane(d, clipAz, clipEl);
  }, [clipEnabled, clipDepth, clipAz, clipEl]);

  // Push the global tractography render settings to the viewer on
  // every change. setTractRenderOptions patches a live ref read inside the
  // drawMesh3D wrapper each frame — never a rebuild.
  useEffect(() => { viewerRef.current?.setTractRenderOptions(tractRender); }, [tractRender]);

  useEffect(() => {
    const el = canvasWrapperRef.current;
    if (!el) return;
    // Ctrl+scroll over the canvas → zoom the 2D views. Plain scroll falls
    // through to NiiVue for 2D-tile slice navigation. Item 102 (6b): NiiVue's
    // OWN sliceScroll3D (which plain scroll over the render tile used to
    // reach) is overridden in NiivueViewer.jsx's setup effect to always zoom
    // the 3D render and never step the clip plane's depth — so scroll no
    // longer needs to be swallowed here at all; the item-61 render-tile
    // swallow this replaced is gone along with the stale-closure refs it
    // needed (showClipSettingsRef/clipEngagedRef). Capture phase +
    // preventDefault only for the ctrl case so plain scroll (2D slice nav,
    // 3D zoom) is never blocked.
    const handleWheel = (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        viewerRef.current?.zoom2D(e.deltaY > 0 ? -1 : 1);
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', handleWheel, { capture: true });
  }, []);  // empty deps: single stable registration; viewerRef.current is always live
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
  // Push view state to the viewer whenever it changes (and once ready).
  useEffect(() => { if (viewerReady) viewerRef.current?.setRadiologicalConvention(radiological); }, [radiological, viewerReady]);
  useEffect(() => { if (viewerReady) viewerRef.current?.setOrientationLabels(orientationLabels); }, [orientationLabels, viewerReady]);
  useEffect(() => { if (viewerReady) viewerRef.current?.setDragMode(dragMode); }, [dragMode, viewerReady]);
  // Auto-switch brushMode when sliceType changes: multiplanar and asymmetric
  // default to 3D (sphere stamps span slices naturally); single-slice views
  // default to 2D (flat disc on the visible slice).
  useEffect(() => {
    const is3DDefault = sliceType === "multiplanar" || sliceType === "asymmetric";
    setBrushMode(is3DDefault ? "3D" : "2D");
  }, [sliceType]);
  // Push measurement markers (3D spheres + 2D slice markers + segments) to the
  // viewer whenever the list or landmark changes — driven here (not in the
  // panel) so markers persist even when the Measurements section is collapsed.
  useEffect(() => {
    if (!viewerReady) return;
    const { points, edges } = measurementsToMarkers(measurements, landmark, pins);
    viewerRef.current?.setMeasurementPoints?.(points, edges);
  }, [measurements, landmark, pins, viewerReady]);

  // ===== Keyboard shortcuts =====
  const shortcuts = useMemo(() => {
    const cycleSlice = (step) => setSliceType((cur) => {
      const idx = SLICE_MODES.findIndex((m) => m.id === cur);
      const next = SLICE_MODES[(idx + step + SLICE_MODES.length) % SLICE_MODES.length];
      setAsymmetric(false);
      return next.id;
    });
    // Axis for nv.moveCrosshairInVox: 0=sagittal(X), 1=coronal(Y), 2=axial(Z).
    // Single-view modes always step that view; the multiplanar grid steps
    // whichever view was last clicked or scrolled in (lastOrientationRef).
    // Asymmetric mode always steps the biggest window (largeSlice) — returns
    // null when the biggest window is the 3D render (no 2D slice axis).
    const currentStepAxis = () => {
      if (asymmetricRef.current) {
        const big = largeSliceRef.current;
        const acs = big === "axial" ? 0 : big === "coronal" ? 1 : big === "sagittal" ? 2 : null;
        return acs == null ? null : 2 - acs;
      }
      const st = sliceTypeRef.current;
      const axCorSag =
        st === "axial" ? 0 : st === "coronal" ? 1 : st === "sagittal" ? 2 : lastOrientationRef.current;
      return 2 - axCorSag;
    };
    const stepBy = (dir) => {
      const ax = currentStepAxis();
      if (ax != null) viewerRef.current?.stepSlice(ax, dir);
    };
    return {
      ArrowUp: () => stepBy(1),
      ArrowDown: () => stepBy(-1),
      PageUp: () => stepBy(1),
      PageDown: () => stepBy(-1),
      // Claimed on the capture-phase listener too (see useKeyboardShortcuts
      // below) — a plain 3D volume just no-ops (stepFrame checks nFrames<=1).
      ArrowLeft: () => stepFrame(-1),
      ArrowRight: () => stepFrame(1),
      "+": () => viewerRef.current?.zoom2D(1),
      "-": () => viewerRef.current?.zoom2D(-1),
      c: () => setCrosshair((v) => !v),
      r: () => setRadiological((v) => !v),
      // Paint mode — delegated to DrawingPanel's own toggle rather than driven
      // here. Enabling is not just setDrawingEnabled(true): it also clears
      // click-to-segment, sets the tool mode and pen type, pushes penValue with
      // `filled` ON, sets the draw opacity, and hands off the crosshair. This
      // shortcut used to do only the first of those, so the pen drew unfilled
      // outlines and the crosshair stayed put.
      //
      // Opening the section first is what MOUNTS DrawingPanel (it unmounts when
      // collapsed, and disables paint mode on the way out — so drawing only
      // ever lives while the section is open). The pending flag is read by the
      // panel's effect on mount, so the request survives that mount.
      d: () => {
        setDrawingSectionOpen(true);
        setDrawTogglePending(true);
      },
      // Both interpolate paths toast on their own when the preconditions aren't
      // met (wrong view, one slice, no drawing), so there's nothing to guard here.
      i: () => viewerRef.current?.interpolateDrawnSlices?.(),
      I: () => viewerRef.current?.interpolateAllDrawnSlices?.(),
      w: () => setDragMode((m) => (m === "zoom" ? "windowing" : m === "windowing" ? "pan" : "zoom")),
      f: () => setFocusMode((v) => !v),
      s: () => viewerRef.current?.saveScreenshot({ caption: baseLabelRef.current }),
      "[": () => cycleSlice(-1),
      "]": () => cycleSlice(1),
      "1": () => { setAsymmetric(false); setSliceType("axial"); },
      "2": () => { setAsymmetric(false); setSliceType("coronal"); },
      "3": () => { setAsymmetric(false); setSliceType("sagittal"); },
      "0": () => viewerRef.current?.resetZoomPan(),
      "?": () => setShowShortcuts((v) => !v),
    };
    // stepFrame is a stable (empty-deps) useCallback identity, so listing it
    // here doesn't reintroduce the stale-closure risk the other refs guard
    // against.
  }, [stepFrame]);
  useKeyboardShortcuts(shortcuts, { captureKeys: ["ArrowLeft", "ArrowRight"] });

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
  // The unsaved scratch drawing can be analysed directly (no Save round-trip):
  // it shows up in the retinotopy picker as an extra option whenever it holds
  // at least one painted voxel. `drawingHasContent` is refreshed from the
  // viewer's draw-change callback below rather than derived from render state,
  // because the bitmap lives outside React entirely.
  const [drawingHasContent, setDrawingHasContent] = useState(false);
  // Read inside the (mount-once) draw-change subscriber, which must not capture
  // a stale selection — see the "Stale closures" invariant in CLAUDE.md §6.
  const drawingSelectedRef = useRef(false);
  drawingSelectedRef.current = selectedLesionIds.has(DRAWING_LESION_ID);

  useEffect(() => {
    if (!viewerReady) return undefined;
    // Captured so the cleanup unsubscribes from the SAME viewer it subscribed
    // to, rather than whatever viewerRef happens to hold at teardown.
    const viewer = viewerRef.current;
    viewer?.setDrawChangeCallback?.(() => {
      setDrawingHasContent(!!viewer?.getDrawingAsVolume?.());
      // Only re-run the analysis when the drawing is what's being analysed.
      // Without this guard every brush stroke would also recompute the overlap
      // for any real lesion layers that happen to be selected.
      if (drawingSelectedRef.current) setDrawVersion((v) => v + 1);
    });
    return () => viewer?.setDrawChangeCallback?.(null);
  }, [viewerReady]);

  // What the retinotopy picker offers: the saved lesion layers, plus the live
  // drawing. The deficit analysis is the ONE consumer that can read an unsaved
  // mask, so this is deliberately NOT folded into `lesionLayers` — Tract
  // Dissection, LNM, and One-Click Summary all resolve a layer id to a cached
  // File, which the scratch drawing has no entry for.
  const retinoLesionOptions = useMemo(() => (
    drawingHasContent
      ? [...lesionLayers, { id: DRAWING_LESION_ID, name: "Current drawing (unsaved)" }]
      : lesionLayers
  ), [lesionLayers, drawingHasContent]);

  // Auto-load polar/eccen atlases (silent, opacity 0) the first time any
  // lesion layer exists. Cheap files; loading once means the legend reflects
  // overlap even when the user hasn't toggled the retinotopy layer on.
  const anyLesion = retinoLesionOptions.length > 0;
  useEffect(() => {
    if (!anyLesion) return;
    ensureRetinotopyLoaded("benson_polar_angle", { silent: true });
    ensureRetinotopyLoaded("benson_eccentricity", { silent: true });
    ensureRetinotopyLoaded("wm_polar_angle", { silent: true });
    ensureRetinotopyLoaded("wm_eccentricity", { silent: true });
  }, [anyLesion, ensureRetinotopyLoaded]);

  // Resolve a picker id to something the overlap maths can read. The drawing
  // id has no niivue volume behind it — it's the scratch bitmap wrapped in the
  // base volume's geometry (see drawingApi.getDrawingAsVolume).
  const lesionVolForId = useCallback((id) => (
    id === DRAWING_LESION_ID
      ? viewerRef.current?.getDrawingAsVolume?.()
      : viewerRef.current?.getVolume?.(id)
  ), []);

  // Drop removed lesions from the picker selection so the analysis stays in sync.
  const lesionIdsKey = retinoLesionOptions.map((l) => l.id).join("|");
  useEffect(() => {
    setSelectedLesionIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(retinoLesionOptions.map((l) => l.id));
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
  // viewerRef is a mutable ref, so retAtlasTick, lesionIdsKey and drawVersion
  // are sentinel triggers that force re-evaluation when an atlas (re)loads, the
  // lesion set changes, or the scratch drawing is edited while selected. eslint
  // can't see through them; the deps are intentional.
  const polarCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("benson_polar_angle");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = lesionVolForId(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey, drawVersion]);

  const eccenCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("benson_eccentricity");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = lesionVolForId(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey, drawVersion]);

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
      const lv = lesionVolForId(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey, drawVersion]);

  const wmEccenCounts = useMemo(() => {
    const viewer = viewerRef.current;
    const atlas = viewer?.getVolume?.("wm_eccentricity");
    if (!atlas?.img || selectedLesionIds.size === 0) return new Map();
    const maps = [];
    for (const id of selectedLesionIds) {
      const lv = lesionVolForId(id);
      if (lv?.img) maps.push(computeVoxelCounts(lv, atlas));
    }
    return unionCounts(maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey, drawVersion]);

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
      const lv = lesionVolForId(id);
      if (lv?.img) grids.push(computeVoxelCounts2D(lv, pa, ec));
    }
    return unionGrids(grids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey, drawVersion]);

  const wm2DGrid = useMemo(() => {
    const viewer = viewerRef.current;
    const pa = viewer?.getVolume?.("wm_polar_angle");
    const ec = viewer?.getVolume?.("wm_eccentricity");
    if (!pa?.img || !ec?.img || selectedLesionIds.size === 0) return null;
    const grids = [];
    for (const id of selectedLesionIds) {
      const lv = lesionVolForId(id);
      if (lv?.img) grids.push(computeVoxelCounts2D(lv, pa, ec));
    }
    return unionGrids(grids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLesionIds, retAtlasTick, lesionIdsKey, drawVersion]);

  const toggleLesionSelected = (id) => {
    setSelectedLesionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const retActive = Object.values(retState).filter((s) => s.visible).length;
  const stdAtlasActive = standardAtlases.filter((a) => atlasState[a.id]?.visible).length;
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
        colorMin: m.color_min, colorMax: m.color_max,
        globalMin: m.global_min, globalMax: m.global_max,
        colormapInverted: m.colormapInverted, // item 55 follow-up
        invertThreshold: m.invertThreshold, // item 118: outside-threshold mode flips the dim bands
      });
    }
    for (const r of ALL_RETINOTOPY_LAYERS) {
      const st = retState[r.id];
      // Skip layers that are loaded but not actually shown. One-Click Summary
      // silently loads the polar/eccen maps at opacity 0 purely to compute the
      // deficit grids; without the opacity guard they leaked into the top panel
      // as dead "PolarAng 0 / Eccen 0 / wm_…0" colorbar chips that do nothing.
      if (!st?.visible || !(st.opacity > 0)) continue;
      const m = overlayMeta[r.id];
      if (!m) continue;
      out.push({
        id: r.id, name: r.name, colormap: retState[r.id].colormap,
        calMin: m.cal_min,
        calMax: m.cal_max,
        colorMin: m.color_min, colorMax: m.color_max,
        globalMin: m.global_min, globalMax: m.global_max,
        colormapInverted: m.colormapInverted, // item 55 follow-up
        invertThreshold: m.invertThreshold, // item 118: outside-threshold mode flips the dim bands
      });
    }
    return out;
  }, [userLayers, retState, overlayMeta]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground" data-testid="dashboard-root">
      <SplashScreen ready={viewerReady} />
      {/* ============ SIDEBAR ============ */}
      {/* Collapsing squeezes the width to 0 and clips overflow rather than
          unmounting the content, so every SidebarSection's open/closed state
          and any in-progress panel input survives collapse/expand. */}
      <aside
        className={`flex-shrink-0 border-r border-border bg-panel flex flex-col overflow-hidden transition-[width] duration-150 ${
          sidebarCollapsed || focusMode ? "w-0 border-r-0" : "w-[400px]"
        }`}
        data-testid="sidebar"
      >
        <div className="w-[400px] flex flex-col h-full">
          <div className="border-b border-border px-5 py-4 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center border border-border">
              <Brain size={16} className="text-foreground" />
            </div>
            <div className="flex-1">
              <div className="text-[15px] font-semibold tracking-tight leading-none">MRLatte</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mt-1">
                base · lesion · roi · activation · atlas · tracts
              </div>
            </div>
            <div className="font-mono text-[10px] text-muted-foreground" data-testid="active-count">
              {totalActive} active
            </div>
            <button
              onClick={() => openStore(null)}
              className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              title={modulesAbsent ? "Module store — some modules are not installed" : "Module store"}
              data-testid="module-store-open"
            >
              <Package size={14} />
              {modulesAbsent && (
                <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-amber-500" />
              )}
            </button>
            <button
              onClick={toggleTheme}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              data-testid="theme-toggle"
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            {/* Item 105: one button for all sections — collapse everything if
                ANY section is open, expand everything only once they are all
                closed. Deliberately not a per-section memory: the point is to
                de-clutter, and "open all" is the escape hatch back. */}
            <button
              onClick={() => setAllSectionsOpen(openSectionCount === 0)}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              title={openSectionCount > 0 ? "Collapse all sections" : "Expand all sections"}
              data-testid="sidebar-sections-toggle"
            >
              {openSectionCount > 0 ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              title="Collapse sidebar"
              data-testid="sidebar-collapse-toggle"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>

          <SidebarSectionsContext.Provider value={sidebarSectionsCtx}>
          <div className="flex-1 overflow-y-auto thin-scroll">
          {/* === 1. Base Volume === */}
          <BaseVolumeSection
            viewerReady={viewerReady}
            baseLabel={baseLabel}
            baseVisible={baseVisible}
            baseOpacity={baseOpacity}
            baseColormap={baseColormap}
            baseFullPath={baseFullPath}
            baseOverlayMeta={baseOverlayMeta}
            baseColorbarOn={baseColorbarOn}
            histograms={histograms}
            requestHistogram={requestHistogram}
            handleBaseVisibilityToggle={handleBaseVisibilityToggle}
            handleBaseOpacity={handleBaseOpacity}
            handleBaseColormap={handleBaseColormap}
            handleBaseCalRange={handleBaseCalRange}
            handleBaseFullWindow={handleBaseFullWindow}
            handleBaseAutoWindow={handleBaseAutoWindow}
            handleBaseColorbarToggle={handleBaseColorbarToggle}
            handleBaseUpload={handleBaseUpload}
            handleDicomImport={handleDicomImport}
            dicomProgress={dicomProgress}
            dicomJob={dicomJob}
            setDicomJob={setDicomJob}
            loadedSeriesId={loadedSeriesId}
            setLoadedSeriesId={setLoadedSeriesId}
            loadDicomSeries={loadDicomSeries}
            dicomDownload={dicomDownload}
            handleResetBase={handleResetBase}
            layerNotes={layerNotes}
            onNotesChange={handleNotesChange}
          />

          {/* === 2. Lesion Masks === */}
          <LesionMasksSection
            lesionSectionOpen={lesionSectionOpen}
            setLesionSectionOpen={setLesionSectionOpen}
            lesionLayers={lesionLayers}
            addUserFile={addUserFile}
            viewerRef={viewerRef}
            standardAtlases={standardAtlases}
            ensureAtlasRegions={ensureAtlasRegions}
            ensureAtlasLoaded={ensureAtlasLoaded}
            userFileCache={userFileCache}
            retState={retState}
            polarOverlap={polarOverlap}
            baseLabel={baseLabel}
            eccenOverlap={eccenOverlap}
            eccenInverted={eccenInverted}
            ensureRetinotopyLoaded={ensureRetinotopyLoaded}
            polarThresh={polarThresh}
            overlayMeta={overlayMeta}
            handleUserEdit={handleUserEdit}
            handleUserDuplicate={handleUserDuplicate}
            handleUserDownload={handleUserDownload}
            handleUserToggle={handleUserToggle}
            handleUserOpacity={handleUserOpacity}
            handleUserColormap={handleUserColormap}
            handleUserColormapInvert={handleUserColormapInvert}
            handleUserClipChange={handleUserClipChange}
            handleUserRemove={handleUserRemove}
            handleCalRangeChange={handleCalRangeChange}
            handleColorRangeChange={handleColorRangeChange}
            handleAutoColorRange={handleAutoColorRange}
            handleAutoThreshold={handleAutoThreshold}
            handleIgnoreZeroChange={handleIgnoreZeroChange}
            handleInvertThresholdChange={handleInvertThresholdChange}
            histograms={histograms}
            requestHistogram={requestHistogram}
            thresholdVolumes={thresholdVolumes}
            scheduleThresholdVolume={scheduleThresholdVolume}
            atlasState={atlasState}
            allRetinotopyLayers={ALL_RETINOTOPY_LAYERS}
            bensonVfMap2dRef={bensonVfMap2dRef}
            wmVfMap2dRef={wmVfMap2dRef}
            benson2DGrid={benson2DGrid}
            wm2DGrid={wm2DGrid}
            polarActive={polarActive}
            eccenActive={eccenActive}
            selectedLesionIds={selectedLesionIds}
            wmPolarOverlap={wmPolarOverlap}
            wmEccenOverlap={wmEccenOverlap}
            layerNotes={layerNotes}
            onNotesChange={handleNotesChange}
          />

          {/* === 2a. Draw / Mask (freehand + spherical ROI in one editable drawing) === */}
          <SidebarSection title="Draw Mask" icon={PencilRuler} testId="section-drawing"
            open={drawingSectionOpen} onOpenChange={setDrawingSectionOpen}>
            <DrawingPanel
              viewerRef={viewerRef}
              baseName={baseLabel}
              crosshair={crosshair}
              onToggleCrosshair={() => setCrosshair((v) => !v)}
              onCrosshairOff={() => setCrosshair(false)}
              onSetCrosshair={(v) => setCrosshair(v)}
              onSaveDrawing={async (file, name) => {
                const id = await addUserFile(file, "lesion", { name });
                if (!id) return id;
                setDrawingSectionOpen(false);
                setLesionSectionOpen(true);
                scrollSectionIntoView("section-lesion");
                return id;
              }}
              clearNonce={clearNonce}
              editingSaveName={editingSaveName}
              editNonce={editNonce}
              activeOrientation={activeOrientation}
              brushMode={brushMode}
              onBrushModeChange={setBrushMode}
              onDrawingActiveChange={setDrawingActive}
              onToolChange={setActiveTool}
              scrollIntoView={() => scrollSectionIntoView("section-drawing")}
              drawTogglePending={drawTogglePending}
              onDrawToggleHandled={() => setDrawTogglePending(false)}
            />
          </SidebarSection>

          {/* === 4. Activation Maps === */}
          <ActivationMapsSection
            open={activationSectionOpen}
            onOpenChange={setActivationSectionOpen}
            autoExpandId={activationAutoExpandId}
            onUploaded={setActivationAutoExpandId}
            activationLayers={activationLayers}
            addUserFile={addUserFile}
            overlayMeta={overlayMeta}
            layerLabelAtlas={layerLabelAtlas}
            handleLayerLabelAtlasChange={handleLayerLabelAtlasChange}
            handleUserToggle={handleUserToggle}
            handleUserOpacity={handleUserOpacity}
            handleUserColormap={handleUserColormap}
            handleUserColormapInvert={handleUserColormapInvert}
            handleUserClipChange={handleUserClipChange}
            handleUserRemove={handleUserRemove}
            handleCalRangeChange={handleCalRangeChange}
            handleColorRangeChange={handleColorRangeChange}
            handleAutoColorRange={handleAutoColorRange}
            handleAutoThreshold={handleAutoThreshold}
            handleIgnoreZeroChange={handleIgnoreZeroChange}
            handleInvertThresholdChange={handleInvertThresholdChange}
            histograms={histograms}
            requestHistogram={requestHistogram}
            thresholdVolumes={thresholdVolumes}
            scheduleThresholdVolume={scheduleThresholdVolume}
            viewerRef={viewerRef}
            standardAtlases={standardAtlases}
            atlasRegions={atlasRegions}
            ensureAtlasLoaded={ensureAtlasLoaded}
            layerNotes={layerNotes}
            onNotesChange={handleNotesChange}
          />

          {/* === 4a. Tractography (sits between Activation Maps and Tract Dissection) === */}
          <TractographySection
            open={tractSectionOpen}
            onOpenChange={setTractSectionOpen}
            autoExpandId={tractAutoExpandId}
            tractLayers={tractLayers}
            tractLoading={tractLoading}
            tractLoadError={tractLoadError}
            setTractLoadError={setTractLoadError}
            handleTractUpload={handleTractUpload}
            handleTractRemove={handleTractRemove}
            handleTractColorMode={handleTractColorMode}
            handleTractSolidColor={handleTractSolidColor}
            handleTractOpacity={handleTractOpacity}
            buildTractReportModelFor={buildTractReportModelFor}
            tractRender={tractRender}
            handleTractRenderChange={handleTractRenderChange}
            handleTractVisible={handleTractVisible}
            handleTractClip={handleTractClip}
            layerNotes={layerNotes}
            onNotesChange={handleNotesChange}
          />

          {/* === 4b. Tract Dissection === */}
          <SidebarSection title="Tract Dissection" icon={GitBranch} testId="section-tract-dissect" open={tractDissectSectionOpen} onOpenChange={setTractDissectSectionOpen} keepMounted>
            {/* Needs the 673 MB whole-brain tractogram; without it the panel is
                replaced by the module install prompt (see ModuleGate). */}
            <ModuleGate capability="dissect" label="Tract dissection">
              <TractDissectionPanel
                viewerRef={viewerRef}
                lesionLayers={lesionLayers}
                userFileCache={userFileCache}
                onSaveTract={(meshName, displayName, meta) => {
                  handleSaveTract(meshName, displayName, meta);
                  setTractAutoExpandId(meshName);
                  setTractDissectSectionOpen(false);
                  setTractSectionOpen(true);
                  scrollSectionIntoView("section-tracts");
                }}
              />
            </ModuleGate>
          </SidebarSection>

          {/* === 4c. Lesion Network Mapping (degree-adjusted) === */}
          <SidebarSection title="Lesion Network Mapping" icon={Network} testId="section-lnm" open={lnmSectionOpen} onOpenChange={setLnmSectionOpen} keepMounted>
            {/* Needs the 131 MB normative connectome bundle. */}
            <ModuleGate capability="lnm" label="Lesion network mapping">
              <DaLnMapperPanel
                viewerRef={viewerRef}
                lesionLayers={lesionLayers}
                userFileCache={userFileCache}
                clearNonce={clearNonce}
                onSaveActivation={async (file, name) => {
                  const id = await handleSaveLnmActivation(file, name);
                  if (id) setActivationAutoExpandId(id);
                  setLnmSectionOpen(false);
                  setActivationSectionOpen(true);
                  scrollSectionIntoView("section-activation");
                  return id;
                }}
              />
            </ModuleGate>
          </SidebarSection>

          {/* === 5b. Measurements & Window === */}
          <SidebarSection title="Measurements & Window" icon={Ruler} testId="section-measure" defaultOpen={false}>
            <MeasurePanel viewerRef={viewerRef} crosshairMM={crosshairMM}
              lesionLayers={lesionLayers} roiLayers={roiLayers} activationLayers={activationLayers}
              measurements={measurements} setMeasurements={setMeasurements}
              landmark={landmark} setLandmark={setLandmark}
              pins={pins} setPins={setPins}
              crosshairValues={crosshairValues} crosshairLabels={crosshairLabels} />
          </SidebarSection>

          {/* === 6. Atlases === */}
          <AtlasesSection
            stdAtlasActive={stdAtlasActive}
            customAtlases={customAtlases}
            atlasState={atlasState}
            handleAtlasToggle={handleAtlasToggle}
            handleAtlasOpacity={handleAtlasOpacity}
            handleAtlasColormap={handleAtlasColormap}
            addUserFile={addUserFile}
            overlayMeta={overlayMeta}
            handleUserToggle={handleUserToggle}
            handleUserOpacity={handleUserOpacity}
            handleUserColormap={handleUserColormap}
            handleUserColormapInvert={handleUserColormapInvert}
            handleUserClipChange={handleUserClipChange}
            handleUserRemove={handleUserRemove}
            handleCalRangeChange={handleCalRangeChange}
            handleColorRangeChange={handleColorRangeChange}
            handleAutoColorRange={handleAutoColorRange}
            handleAutoThreshold={handleAutoThreshold}
            handleIgnoreZeroChange={handleIgnoreZeroChange}
            handleInvertThresholdChange={handleInvertThresholdChange}
            histograms={histograms}
            requestHistogram={requestHistogram}
            thresholdVolumes={thresholdVolumes}
            scheduleThresholdVolume={scheduleThresholdVolume}
            layerNotes={layerNotes}
            onNotesChange={handleNotesChange}
            standardAtlases={standardAtlases}
            atlasRegions={atlasRegions}
            ensureAtlasRegions={ensureAtlasRegions}
            reorderAtlases={reorderAtlases}
            openAtlasManager={openAtlasManager}
            handleAtlasClipChange={handleAtlasClipChange}
            onAtlasNavigate={handleAtlasNavigate}
            onAtlasRegionMask={handleAtlasRegionMask}
            onAtlasRegionColors={handleAtlasRegionColors}
            onAtlasIsolate={handleAtlasIsolate}
            atlasIsolate={atlasIsolate}
          />

          {/* === 7. Retinotopy === */}
          <RetinotopySection
            retActive={retActive}
            overlayMeta={overlayMeta}
            retState={retState}
            handleRetToggle={handleRetToggle}
            handleRetOpacity={handleRetOpacity}
            handleRetColormap={handleRetColormap}
            handleCalRangeChange={handleCalRangeChange}
            handleColorRangeChange={handleColorRangeChange}
            handleAutoColorRange={handleAutoColorRange}
            handleAutoThreshold={handleAutoThreshold}
            handleIgnoreZeroChange={handleIgnoreZeroChange}
            handleInvertThresholdChange={handleInvertThresholdChange}
            histograms={histograms}
            requestHistogram={requestHistogram}
            thresholdVolumes={thresholdVolumes}
            scheduleThresholdVolume={scheduleThresholdVolume}
            lesionLayers={retinoLesionOptions}
            lesionPickerOpen={lesionPickerOpen}
            setLesionPickerOpen={setLesionPickerOpen}
            selectedLesionIds={selectedLesionIds}
            toggleLesionSelected={toggleLesionSelected}
            bensonViewMode={bensonViewMode}
            setBensonViewMode={setBensonViewMode}
            bensonVfMap2dRef={bensonVfMap2dRef}
            benson2DGrid={benson2DGrid}
            polarOverlap={polarOverlap}
            polarThresh={polarThresh}
            setPolarThresh={setPolarThresh}
            polarActive={polarActive}
            baseLabel={baseLabel}
            eccenOverlap={eccenOverlap}
            eccenThresh={eccenThresh}
            setEccenThresh={setEccenThresh}
            eccenInverted={eccenInverted}
            handleEccenInvert={handleEccenInvert}
            eccenActive={eccenActive}
            wmAvailable={wmAvailable}
            wmVfMap2dRef={wmVfMap2dRef}
            wm2DGrid={wm2DGrid}
            wmPolarOverlap={wmPolarOverlap}
            wmEccenOverlap={wmEccenOverlap}
            layerNotes={layerNotes}
            onNotesChange={handleNotesChange}
          />

          {/* === 9. Longitudinal === */}
          <SidebarSection title="Longitudinal" icon={GitCompareArrows} testId="section-longitudinal" defaultOpen={false}>
            <LongitudinalPanel
              onDiffLoaded={(file, opts) => addUserFile(file, "activation", { ...opts, name: `Longitudinal Diff · ${new Date().toLocaleDateString()}` })}
            />
          </SidebarSection>

          <div className="px-5 py-4 mt-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-subtle leading-relaxed">
              Atlases: AAL · Harvard-Oxford · Jülich (white matter). Retinotopy: Benson 2014 + Wang 2015. Cerebellum excluded in retinotopy.
            </div>
          </div>
          </div>
          </SidebarSectionsContext.Provider>
          </div>
      </aside>
      {sidebarCollapsed && !focusMode && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="flex-shrink-0 w-6 flex flex-col items-center justify-center border-r border-border bg-panel text-muted-foreground hover:text-foreground hover:bg-panel-hover transition-colors"
          title="Expand sidebar"
          data-testid="sidebar-expand-toggle"
        >
          <PanelLeftOpen size={14} />
        </button>
      )}

      {/* ============ MAIN VIEWER ============ */}
      {/* bg-black is intentionally NOT theme-tokenized: the NiiVue canvas's
          WebGL clear color is fixed dark (see NiivueViewer's `backColor`)
          regardless of app theme — scan images are optimized for a dark
          viewing background. A light container here would show as a pale
          halo around the dark render. */}
      <main className="flex-1 flex flex-col min-h-0 min-w-0 bg-black relative" data-testid="viewer-main">
        {/* Focus/presentation mode: a single floating control to exit, no other chrome. */}
        {focusMode && (
          <button
            onClick={() => setFocusMode(false)}
            className="absolute top-2 right-2 z-20 flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-[0.15em] border border-white/20 bg-black/60 text-zinc-200 hover:text-white hover:border-white/50 transition-colors"
            title="Exit focus mode (F)"
            data-testid="focus-exit"
          >
            <Minimize2 size={12} /> Exit focus
          </button>
        )}
        {focusMode ? null : topbarCollapsed ? (
          <button
            onClick={() => setTopbarCollapsed(false)}
            className="flex w-full items-center justify-center gap-2 border-b border-border bg-panel py-1 text-muted-foreground hover:text-foreground hover:bg-panel-hover transition-colors"
            title="Show toolbar"
            data-testid="topbar-expand-toggle"
          >
            <PanelTopOpen size={13} />
          </button>
        ) : (
        <div className="flex items-center justify-between gap-2 flex-wrap border-b border-border bg-panel px-4 py-2.5" data-testid="topbar">
          <div className="flex items-center gap-1 flex-wrap">
            {SLICE_MODES.map((m) => {
              const Icon = m.icon;
              const active = sliceType === m.id && !asymmetric;
              return (
                <button key={m.id} onClick={() => { setAsymmetric(false); setSliceType(m.id); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border ${activeToggleCls(active)}`} data-testid={`slice-mode-${m.id}`}>
                  <Icon size={12} /><span>{m.label}</span>
                </button>
              );
            })}
            {/* Asymmetric: 1 large + 3 stacked side views */}
            <button
              onClick={() => setAsymmetric((v) => !v)}
              className={`w-full flex items-center justify-center gap-2 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border ${activeToggleCls(asymmetric)}`}
              data-testid="slice-mode-asymmetric"
              title="Asymmetric: one large + three stacked side views. Double-click a side to promote."
            >
              <Columns3 size={12} /><span>Asymmetric</span>
            </button>
            {/* Radiological / neurological convention (flips axial+coronal + labels) */}
            <button
              onClick={() => setRadiological((v) => !v)}
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                radiological ? "bg-panel-hover text-foreground border-muted-foreground" : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              }`}
              data-testid="radiological-toggle"
              title="Radiological convention: mirror axial & coronal (L/R swap). Off = neurological."
            >
              <FlipHorizontal2 size={12} /><span>{radiological ? "Radiological" : "Neurological"}</span>
            </button>
            {/* Left-drag mode: crosshair / windowing / pan */}
            {/* Right-drag mode: left-click is always crosshair (when not
                drawing); this toggle only changes what right-drag does. */}
            {/* Right-drag mode: Zoom / Window / Pan (always clickable; clicking
                any of them while drawing exits draw mode) + a locked 4th
                "Right-drag: Erase" indicator while drawing is active. */}
            <div className="flex items-center border border-border" data-testid="drag-mode-toggle">
              {[
                { id: "zoom", icon: ZoomIn, label: "Zoom" },
                { id: "windowing", icon: Contrast, label: "Window" },
                { id: "pan", icon: Move, label: "Pan" },
              ].map((m) => {
                const Icon = m.icon;
                const active = dragMode === m.id;
                return (
                  <button key={m.id} onClick={() => {
                      setDragMode(m.id);
                      if (drawingActive) viewerRef.current?.setDrawingEnabled?.(false);
                    }}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] transition-colors ${
                      active && !drawingActive ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid={`drag-mode-${m.id}`}
                    title={`Right-drag: ${m.label}`}>
                    <Icon size={12} />
                  </button>
                );
              })}
              {/* 4th indicator: visible only in draw mode, locked to "Erase" */}
              {drawingActive && (
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] bg-primary text-primary-foreground cursor-default"
                  data-testid="drag-mode-draw-erase"
                  title="Right-drag: Erase (active while drawing)"
                  tabIndex={-1}
                >
                  <Pencil size={12} />
                </button>
              )}
            </div>
            {/* Jump the crosshair to a typed MNI coordinate. Routes through the
                shared setCrosshairMM navigation primitive (same as the atlas
                region buttons / visfAtlas jump / workspace restore). */}
            <GotoMniInput current={crosshairMM} onGo={(x, y, z) => viewerRef.current?.setCrosshairMM?.(x, y, z)} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setFocusMode(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="focus-mode-toggle"
              title="Focus mode: hide all panels (F)"
            >
              <Minimize2 size={12} />Focus
            </button>
            <button
              onClick={() => setShowShortcuts(true)}
              className="flex h-[30px] w-8 items-center justify-center transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="shortcuts-help-toggle"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard size={13} />
            </button>
            <button onClick={clearAllOverlays}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-destructive hover:border-destructive"
              data-testid="clear-all-overlays">
              <Trash2 size={12} />Clear All
            </button>
            <div className="relative" ref={crosshairSettingsRef}>
              <div className="flex">
                <button onClick={() => setCrosshair((c) => !c)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                    crosshair ? "bg-panel-hover text-foreground border-muted-foreground" : "bg-transparent text-muted-foreground border-border hover:text-foreground"
                  }`} data-testid="crosshair-toggle">
                  <CrosshairIcon size={12} />Crosshair
                </button>
                <button
                  onClick={() => { setShowCrosshairSettings((v) => !v); setShowClipSettings(false); }}
                  className="px-1.5 py-1.5 text-[9px] border border-l-0 border-border text-muted-foreground hover:text-foreground transition-colors"
                  title="Crosshair style options"
                  data-testid="crosshair-settings-toggle"
                >▾</button>
              </div>
              {showCrosshairSettings && (
                <div className="absolute right-0 top-full z-50 mt-1 w-52 border border-border bg-panel p-3 space-y-2.5 shadow-lg" data-testid="crosshair-settings-panel">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">thickness</span>
                      <span className="font-mono text-[10px] text-foreground">{crosshairWidth}</span>
                    </div>
                    <Slider value={[crosshairWidth]} min={1} max={5} step={1}
                      onValueChange={(v) => setCrosshairWidth(v[0])}
                      className="cursor-pointer" data-testid="crosshair-width" />
                  </div>
                  <div className="space-y-1.5">
                    <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">color</span>
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
                          className={`h-5 w-5 ${bg} transition-opacity ${crosshairColor === key ? "ring-2 ring-foreground ring-offset-1 ring-offset-panel" : "opacity-60 hover:opacity-100"}`}
                          data-testid={`crosshair-color-${key}`}
                          title={key}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-border">
                    <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">orient. labels</span>
                    <button
                      onClick={() => setOrientationLabels((v) => !v)}
                      className={`relative inline-flex h-4 w-8 transition-colors border ${
                        orientationLabels ? "bg-primary border-primary" : "bg-transparent border-border"
                      }`}
                      data-testid="orientation-labels-toggle"
                    >
                      <span className={`inline-block h-3 w-3 transition-transform ${orientationLabels ? "translate-x-4 bg-primary-foreground" : "translate-x-0 bg-muted-foreground"}`} />
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="relative" data-testid="clip-plane-control" ref={clipSettingsRef}>
              <div className="flex">
                <button
                  onClick={() => setClipEnabled((v) => !v)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border ${
                    clipEnabled ? "bg-panel-hover text-foreground border-muted-foreground" : "bg-transparent text-muted-foreground border-border hover:text-foreground"
                  }`}
                  data-testid="clip-plane-toggle"
                  title="Clip plane — cut away part of the 3D render"
                >
                  <Scissors size={12} />Clip Plane
                </button>
                <button
                  onClick={() => { setShowClipSettings((v) => !v); setShowCrosshairSettings(false); }}
                  className="px-1.5 py-1.5 text-[9px] border border-l-0 border-border text-muted-foreground hover:text-foreground transition-colors"
                  title="Clip plane options"
                  data-testid="clip-plane-settings-toggle"
                >▾</button>
              </div>
              {showClipSettings && (
                <div className="absolute right-0 top-full z-50 mt-1 w-64 border border-border bg-panel p-3 space-y-3 shadow-lg" data-testid="clip-plane-settings-panel">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground w-10 flex-shrink-0">depth</span>
                    <Slider value={[clipDepth]} min={-0.6} max={0.6} step={0.02}
                      onValueChange={(v) => setClipDepth(v[0])}
                      className="cursor-pointer flex-1" data-testid="clip-plane-slider" />
                    <span className="font-mono text-[10px] text-foreground tabular-nums w-10 text-right">
                      {clipDepth.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground w-10 flex-shrink-0">az</span>
                    <Slider value={[clipAz]} min={-180} max={180} step={5}
                      onValueChange={(v) => setClipAz(v[0])}
                      className="cursor-pointer flex-1" data-testid="clip-az-slider" />
                    <span className="font-mono text-[10px] text-foreground tabular-nums w-10 text-right">{Math.round(clipAz)}°</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground w-10 flex-shrink-0">el</span>
                    {/* Item 104: -180..180, not -90..90. The clip-plane normal
                        is sph2cartDeg(az+180, el), whose period in elevation is
                        360° — so only a full-turn range lets a sustained
                        right-drag wrap seamlessly instead of sticking at a pole
                        (a -90..90 fold would flip the plane to the far side). */}
                    <Slider value={[clipEl]} min={-180} max={180} step={5}
                      onValueChange={(v) => setClipEl(v[0])}
                      className="cursor-pointer flex-1" data-testid="clip-el-slider" />
                    <span className="font-mono text-[10px] text-foreground tabular-nums w-10 text-right">{Math.round(clipEl)}°</span>
                  </div>
                  <button
                    onClick={() => { setClipDepth(0); setClipAz(0); setClipEl(0); }}
                    className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="clip-plane-reset"
                  >reset</button>
                  <div className="font-mono text-[9px] text-subtle leading-relaxed">
                    depth 0 = centered · az/el track the render's own rotation while dragged (right-drag) · Clip Plane button toggles on/off, values persist
                  </div>
                </div>
              )}
            </div>
            <button onClick={handleSaveWorkspace}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="workspace-save" title="Save the current workspace (scan, overlays, settings) to a file">
              <Save size={12} />Save
            </button>
            <button onClick={handleOpenWorkspace}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="workspace-open" title="Restore a saved workspace file">
              <FolderOpen size={12} />Open
            </button>
            <button onClick={() => viewerRef.current?.saveScreenshot({ caption: baseLabel })}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="screenshot-button">
              <Camera size={12} />Screenshot
            </button>
            <button
              onClick={() => setTopbarCollapsed(true)}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              title="Hide toolbar"
              data-testid="topbar-collapse-toggle"
            >
              <PanelTopClose size={13} />
            </button>
          </div>
        </div>
        )}

        {!focusMode && (
          <div className="border-b border-border bg-background px-4 py-2">
            <CrosshairInfo mm={crosshairMM} vox={crosshairVox} labels={crosshairLabels} values={crosshairValues} />
          </div>
        )}

        <div ref={canvasWrapperRef} className="flex-1 relative min-h-0">
          {initialBaseVolume && (
            <NiivueViewer
              ref={viewerRef}
              baseVolume={initialBaseVolume}
              sliceType={sliceType}
              activeOrientation={activeOrientation}
              onReady={() => { setViewerReady(true); refreshBaseOverlayMeta(); }}
              onLocationChange={handleLocationChange}
              onDoubleClickSlice={handleDoubleClickSlice}
              onClipRotateDelta={handleClipRotateDelta}
              onFrameChange={handleFrameChange}
              clipEnabled={clipEnabled}
              tractRender={tractRender}
              drawToolLabel={activeTool === "brush" ? `${brushMode} Brush/Erase` : ""}
            />
          )}
          <ColorBarStack entries={colorBarEntries} />
          <FrameStepper frame={frameInfo.frame} nFrames={frameInfo.nFrames} onStepFrame={stepFrame} onSetFrame={setFrame} timeseriesData={timeseriesData} />
          {loadBarVisible && (
            // Covers the gap SplashScreen doesn't: a base-volume swap (e.g.
            // a large 4D file) AFTER the window's initial load, where
            // nothing else signals "still working". See loadBarPct's effect
            // above for why this is a simulated, not measured, percentage.
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 pointer-events-none"
              data-testid="base-loading-overlay"
            >
              <div className="flex flex-col items-center gap-2 bg-black/70 border border-white/15 rounded-lg px-4 py-3 w-56">
                <span className="font-mono text-[11px] text-zinc-100">Loading volume…</span>
                <div className="h-1 w-full bg-white/15 overflow-hidden rounded-full">
                  <div
                    className="h-full bg-zinc-100 transition-[width] ease-out"
                    style={{ width: `${loadBarPct}%`, transitionDuration: loadBarPct >= 100 ? "150ms" : "300ms" }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {!focusMode && (
          <div className="border-t border-border bg-panel px-4 py-2 flex items-center" data-testid="bottom-controls">
            <div className="flex items-center gap-4 ml-auto font-mono text-[10px] text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${viewerReady ? "bg-emerald-500" : "bg-amber-500"}`} />
                <span>{viewerReady ? "WebGL ready" : "loading"}</span>
              </div>
              <div><span className="text-subtle">overlays</span>{" "}<span className="text-foreground">{totalActive}</span></div>
            </div>
          </div>
        )}
      </main>

      {/* Module store overlay. Renders nothing until opened — from the sidebar
          header button or from a ModuleGate install prompt (both go through
          ModuleProvider's openStore). */}
      <ModuleStore />

      {/* Atlas manager overlay — installed list, 1-click catalog and the
          import wizard. Renders nothing until opened (AtlasProvider's
          openManager), from the Atlases section header or its empty state. */}
      <AtlasManager onChanged={refreshAtlases} />

      {/* Keyboard shortcuts help overlay */}
      {showShortcuts && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={() => setShowShortcuts(false)}
          data-testid="shortcuts-help"
        >
          <div
            className="w-[380px] max-w-[90vw] border border-border bg-panel p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                <Keyboard size={14} className="text-muted-foreground" /> Keyboard shortcuts
              </div>
              <button onClick={() => setShowShortcuts(false)} className="text-muted-foreground hover:text-foreground" data-testid="shortcuts-help-close">
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
              {[
                ["↑ / ↓ · PgUp / PgDn", "Previous / next slice"],
                ["Ctrl + scroll", "Zoom the 2D views"],
                ["+ / −", "Zoom in / out"],
                ["[ / ]", "Cycle slice layout"],
                ["1 / 2 / 3", "Axial / Coronal / Sagittal view"],
                ["0", "Reset zoom / pan"],
                ["C", "Toggle crosshair"],
                ["R", "Radiological / neurological"],
                ["W", "Cycle drag mode (locate/window/pan)"],
                ["F", "Focus mode"],
                ["S", "Screenshot"],
                ["D", "Toggle drawing mode"],
                ["I", "Interpolate last 2 slices"],
                ["Shift + I", "Interpolate all drawn slices"],
                ["← / →", "Previous / next frame (4D)"],
                ["?", "This help"],
              ].map(([k, d]) => (
                <React.Fragment key={k}>
                  <kbd className="font-mono text-[10px] text-foreground bg-panel-hover border border-border px-1.5 py-0.5 self-start whitespace-nowrap">{k}</kbd>
                  <span className="text-muted-foreground self-center">{d}</span>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// UserLayerList moved to components/UserLayerList.jsx (shared by the Lesion
// Masks, Activation Maps, and Atlases sidebar sections).

function typeLabel(t) {
  return { lesion: "Lesion", roi: "ROI", activation: "Activation", atlas: "Atlas" }[t] || "Layer";
}

// Display name for an atlas id, from the registry. The four-entry hardcoded
// map this replaces named a fraction of the installed atlases and could never
// know about one the user installed or imported.
function shortAtlas(name, resolve) {
  return resolve?.(name)?.short || name;
}

function shortLayerName(name) {
  if (!name) return "";
  const map = {
    mni152: "MNI152",
    wang2015_maxprob: "Wang",
    benson_polar_angle: "PolarAng",
    benson_eccentricity: "Eccen",
    benson_visual_areas: "VArea",
  };
  if (map[name]) return map[name];
  // Atlas ids are resolved by the caller-facing shortAtlas(); here we only
  // handle the fixed non-atlas layers plus user layers.
  // User-uploaded layers carry IDs like "user-1234567890". Trim ids.
  if (name.startsWith("user-")) return "User";
  return name.length > 12 ? name.slice(0, 12) + "…" : name;
}
