import React, { useState } from "react";
import { Ruler, Move3d, AlignVerticalSpaceAround, Box, Crosshair, Plus, Trash2, Triangle, Sigma, MapPin, Download } from "lucide-react";
import { distanceMM, angleDeg, lesionMaxDiameter, lesionVolume, midlineShift, maskIntensityStats } from "@/lib/measure";
import { saveBinaryFile } from "@/lib/workspace";
import { toast } from "sonner";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ghostBtnCls, panelSelectCls, primaryBtnCls } from "@/lib/buttonVariants";

// Quotes a CSV field per RFC 4180 (wraps in quotes, doubling any embedded
// quotes) whenever it contains a comma, quote, or newline.
function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells) {
  return cells.map(csvField).join(",") + "\r\n";
}

// Palette must match MEASURE_COLORS_RGB in NiivueViewer (per-measurement colour
// cycle) so the panel's colour chip equals the marker/sphere colour.
const MEASURE_COLORS = [
  [56, 220, 220], [255, 150, 40], [255, 220, 40],
  [120, 235, 120], [235, 120, 235], [120, 170, 255],
];
const colorCss = (idx) => `rgb(${MEASURE_COLORS[idx % MEASURE_COLORS.length].join(",")})`;

const emptyPoint = (label) => ({ label, mm: null, t: ["", "", ""] });
const makeMeasurement = (type, n) => ({
  id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  type,
  name: (type === "angle" ? "Angle " : "Distance ") + n,
  // Angle: A – Vertex – B (vertex is the middle point).
  points: type === "angle"
    ? [emptyPoint("A"), emptyPoint("V"), emptyPoint("B")]
    : [emptyPoint("A"), emptyPoint("B")],
});

/**
 * MeasurePanel — a named list of distance / angle measurements (each with 3D
 * spheres + 2D slice markers via the viewer), plus lesion diameter, midline
 * shift, lesion volume, and ROI intensity statistics.
 *
 * `measurements` / `landmark` are owned by the parent (Dashboard) so they
 * survive this section collapsing and can be saved to the workspace; the
 * parent also owns the effect that pushes markers to the viewer.
 */
export const MeasurePanel = ({
  viewerRef, crosshairMM, lesionLayers = [], roiLayers = [], activationLayers = [],
  measurements, setMeasurements, landmark, setLandmark,
  pins = [], setPins, crosshairValues = [], crosshairLabels = {},
}) => {
  const [diam, setDiam] = useState(null);
  const [vol, setVol] = useState(null);
  const [selLesion, setSelLesion] = useState("");
  const [expandedPin, setExpandedPin] = useState(null);

  const addPin = () => {
    if (!crosshairMM) return;
    const id = `pin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setPins((p) => [...p, {
      id,
      name: `Pin ${p.length + 1}`,
      mm: [crosshairMM[0], crosshairMM[1], crosshairMM[2]],
      values: crosshairValues.map((v) => ({ name: v.name, value: v.value })),
      labels: { ...crosshairLabels },
    }]);
    setExpandedPin(id);
  };
  const removePin = (id) => setPins((p) => p.filter((pin) => pin.id !== id));
  const renamePin = (id, name) => setPins((p) => p.map((pin) => (pin.id === id ? { ...pin, name } : pin)));

  // ROI intensity stats selections + result.
  const [maskSrc, setMaskSrc] = useState("");
  const [intensitySrc, setIntensitySrc] = useState("__base__");
  const [roiStats, setRoiStats] = useState(null);

  const addMeasurement = (type) => {
    setMeasurements((p) => [...p, makeMeasurement(type, p.filter((m) => m.type === type).length + 1)]);
  };
  const removeMeasurement = (id) => setMeasurements((p) => p.filter((m) => m.id !== id));
  const renameMeasurement = (id, name) => setMeasurements((p) => p.map((m) => (m.id === id ? { ...m, name } : m)));

  // Update one axis of one point's text; commit to mm once all three parse.
  const setPointText = (mid, pi, axis, val) => {
    setMeasurements((p) => p.map((m) => {
      if (m.id !== mid) return m;
      const points = m.points.map((pt, i) => {
        if (i !== pi) return pt;
        const t = [...pt.t]; t[axis] = val;
        const nums = t.map(parseFloat);
        const mm = nums.every(Number.isFinite) ? nums : pt.mm;
        return { ...pt, t, mm };
      });
      return { ...m, points };
    }));
  };
  const setPointFromCrosshair = (mid, pi) => {
    if (!crosshairMM) return;
    const mm = [crosshairMM[0], crosshairMM[1], crosshairMM[2]];
    setMeasurements((p) => p.map((m) => {
      if (m.id !== mid) return m;
      const points = m.points.map((pt, i) =>
        i === pi ? { ...pt, mm, t: mm.map((v) => v.toFixed(1)) } : pt);
      return { ...m, points };
    }));
  };

  const measureValue = (m) => {
    const mm = m.points.map((pt) => pt.mm);
    if (m.type === "distance") {
      const d = distanceMM(mm[0], mm[1]);
      return d != null ? `${d.toFixed(1)} mm` : "—";
    }
    const a = angleDeg(mm[0], mm[1], mm[2]); // vertex = index 1
    return a != null ? `${a.toFixed(1)}°` : "—";
  };

  const fmt = (p) => (p ? `${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}` : "—");
  const ms = midlineShift(landmark);

  // Exports everything currently computed in this panel as one CSV file,
  // grouped into labeled sections (measurements, pins, then whichever of
  // diameter/midline/volume/ROI-stats have been computed this session).
  const exportCSV = async () => {
    let csv = "";
    csv += csvRow(["Section", "Name", "Type", "Value", "Point A (mm)", "Point B (mm)", "Point C (mm)"]);
    measurements.forEach((m) => {
      const mm = m.points.map((pt) => pt.mm);
      csv += csvRow(["Measurement", m.name, m.type, measureValue(m), fmt(mm[0]), fmt(mm[1]), fmt(mm[2])]);
    });
    csv += "\r\n";

    if (pins.length > 0) {
      const layerNames = [...new Set(pins.flatMap((p) => p.values.map((v) => v.name)))];
      csv += csvRow(["Pin", "Name", "MM", ...layerNames]);
      pins.forEach((p) => {
        const byName = Object.fromEntries(p.values.map((v) => [v.name, v.value]));
        csv += csvRow(["Pin", p.name, fmt(p.mm), ...layerNames.map((n) => (byName[n] != null ? Number(byName[n]).toFixed(3) : ""))]);
      });
      csv += "\r\n";
    }

    if (diam) {
      csv += csvRow(["Lesion max diameter", "", "", `${diam.diameterMM.toFixed(1)} mm`, "", "", ""]);
      csv += csvRow(["Lesion max diameter voxels", "", "", diam.voxelCount, "", "", ""]);
      csv += "\r\n";
    }
    if (ms) {
      csv += csvRow(["Midline shift", "", "", `${ms.shiftMM.toFixed(1)} mm (${ms.side})`, "", "", ""]);
      csv += "\r\n";
    }
    if (vol) {
      csv += csvRow(["Volume", "", "", `${vol.volumeCM3.toFixed(2)} cm3`, "", "", ""]);
      csv += csvRow(["Volume voxels", "", "", vol.voxelCount, "", "", ""]);
      csv += "\r\n";
    }
    if (roiStats) {
      csv += csvRow(["ROI stats mean", "", "", roiStats.mean.toFixed(3), "", "", ""]);
      csv += csvRow(["ROI stats sd", "", "", roiStats.sd.toFixed(3), "", "", ""]);
      csv += csvRow(["ROI stats min", "", "", roiStats.min.toFixed(3), "", "", ""]);
      csv += csvRow(["ROI stats max", "", "", roiStats.max.toFixed(3), "", "", ""]);
      csv += csvRow(["ROI stats voxel count", "", "", roiStats.count, "", "", ""]);
    }

    const bytes = new TextEncoder().encode(csv);
    const date = new Date().toISOString().slice(0, 10);
    const r = await saveBinaryFile(`mrlatte-measurements-${date}.csv`, "text/csv", bytes);
    if (!r.canceled) toast.success("Measurements exported");
  };

  const computeDiameter = () => {
    const id = selLesion || lesionLayers[0]?.id;
    if (!id) return toast.error("No lesion layer");
    const v = viewerRef.current?.getVolume?.(id);
    if (!v?.img) return toast.error("Lesion volume unavailable");
    const r = lesionMaxDiameter(v);
    if (!r) return toast.error("Could not measure");
    setDiam(r);
  };
  const computeVolume = () => {
    const id = selLesion || lesionLayers[0]?.id;
    if (!id) return toast.error("No lesion layer");
    const v = viewerRef.current?.getVolume?.(id);
    if (!v?.img) return toast.error("Lesion volume unavailable");
    const r = lesionVolume(v);
    if (!r) return toast.error("Could not estimate volume");
    setVol(r);
  };
  const computeDrawingVolume = () => {
    const v = viewerRef.current?.getDrawingAsVolume?.();
    if (!v?.img) return toast.error("Nothing drawn yet");
    const r = lesionVolume(v);
    if (!r) return toast.error("Could not estimate volume");
    setVol(r);
  };

  const maskOptions = [
    ...lesionLayers.map((l) => ({ id: l.id, name: l.name })),
    ...roiLayers.map((l) => ({ id: l.id, name: l.name })),
    { id: "__drawing__", name: "Current drawing" },
  ];
  const intensityOptions = [
    { id: "__base__", name: "Base volume" },
    ...activationLayers.map((l) => ({ id: l.id, name: l.name })),
  ];
  const computeRoiStats = () => {
    const maskVol = maskSrc === "__drawing__"
      ? viewerRef.current?.getDrawingAsVolume?.()
      : viewerRef.current?.getVolume?.(maskSrc || maskOptions[0]?.id);
    if (!maskVol?.img) return toast.error("Select a mask with voxels");
    const intVol = intensitySrc === "__base__"
      ? viewerRef.current?.getBaseVolume?.()
      : viewerRef.current?.getVolume?.(intensitySrc);
    if (!intVol?.img) return toast.error("Intensity volume unavailable");
    const r = maskIntensityStats(maskVol, intVol);
    if (!r) return toast.error("No overlapping voxels found");
    setRoiStats(r);
  };

  const btn = ghostBtnCls;
  const selectCls = panelSelectCls;
  const coordInputCls = "w-full bg-panel border border-border text-[11px] text-foreground px-1.5 py-1 text-center";

  const pointRow = (m, pt, pi) => (
    <div key={pi} className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] text-muted-foreground w-3 flex-shrink-0">{pt.label}</span>
      {[0, 1, 2].map((ax) => (
        <input key={ax} type="number" value={pt.t[ax]} placeholder={["x", "y", "z"][ax]}
          onChange={(e) => setPointText(m.id, pi, ax, e.target.value)}
          className={coordInputCls} data-testid={`measure-${m.id}-p${pi}-${["x", "y", "z"][ax]}`} />
      ))}
      <button onClick={() => setPointFromCrosshair(m.id, pi)} title="Use crosshair position"
        className="flex-shrink-0 flex items-center justify-center h-[26px] w-[26px] border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
        data-testid={`measure-${m.id}-p${pi}-crosshair`}>
        <Crosshair size={11} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="measure-panel">
      {/* Export everything computed in this panel as one CSV file. */}
      <button
        className={`w-full ${btn}`}
        onClick={exportCSV}
        disabled={measurements.length === 0 && pins.length === 0 && !diam && !ms && !vol && !roiStats}
        data-testid="export-measurements-csv"
      >
        <Download size={11} /> Export CSV
      </button>

      {/* Measurements list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
            <Ruler size={11} /> measurements
          </div>
          <div className="flex items-center gap-1">
            <button className={btn} onClick={() => addMeasurement("distance")} data-testid="add-distance">
              <Plus size={11} /> Dist
            </button>
            <button className={btn} onClick={() => addMeasurement("angle")} data-testid="add-angle">
              <Triangle size={11} /> Angle
            </button>
          </div>
        </div>

        {measurements.length === 0 && (
          <div className="font-mono text-[9px] text-subtle leading-relaxed">
            Add a distance (2 points) or angle (3 points). Set each point from the
            crosshair or by typing MNI mm coordinates.
          </div>
        )}

        {measurements.map((m, mi) => (
          <div key={m.id} className="border border-border bg-panel p-2 space-y-1.5" data-testid={`measurement-${m.id}`}>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 flex-shrink-0" style={{ background: colorCss(mi) }} />
              <input value={m.name} onChange={(e) => renameMeasurement(m.id, e.target.value)}
                className="flex-1 min-w-0 bg-transparent text-[11px] text-foreground focus:outline-none"
                data-testid={`measurement-name-${m.id}`} />
              <span className="font-mono text-[11px] text-foreground tabular-nums flex-shrink-0">{measureValue(m)}</span>
              <button onClick={() => removeMeasurement(m.id)}
                className="text-muted-foreground hover:text-destructive flex-shrink-0" data-testid={`measurement-remove-${m.id}`}>
                <Trash2 size={12} />
              </button>
            </div>
            {m.points.map((pt, pi) => pointRow(m, pt, pi))}
          </div>
        ))}
      </div>

      <div className="h-px bg-border" />

      {/* Pins: labeled probes that snapshot the value at a voxel across
          every visible layer at the moment they're dropped. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
            <MapPin size={11} /> pins
          </div>
          <button className={btn} onClick={addPin} disabled={!crosshairMM} data-testid="add-pin">
            <Plus size={11} /> Pin @ Crosshair
          </button>
        </div>

        {pins.length === 0 && (
          <div className="font-mono text-[9px] text-subtle leading-relaxed">
            Drop a pin at the crosshair to record the value at that voxel across every visible layer.
          </div>
        )}

        {pins.map((p, pi) => {
          const isOpen = expandedPin === p.id;
          const colorIdx = measurements.length + 1 + pi;
          return (
            <div key={p.id} className="border border-border bg-panel p-2 space-y-1.5" data-testid={`pin-${p.id}`}>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 flex-shrink-0" style={{ background: colorCss(colorIdx) }} />
                <input value={p.name} onChange={(e) => renamePin(p.id, e.target.value)}
                  className="flex-1 min-w-0 bg-transparent text-[11px] text-foreground focus:outline-none"
                  data-testid={`pin-name-${p.id}`} />
                <button onClick={() => setExpandedPin(isOpen ? null : p.id)}
                  className="font-mono text-[9px] text-muted-foreground hover:text-foreground flex-shrink-0"
                  data-testid={`pin-toggle-${p.id}`}>
                  {isOpen ? "hide" : "values"}
                </button>
                <button onClick={() => removePin(p.id)}
                  className="text-muted-foreground hover:text-destructive flex-shrink-0" data-testid={`pin-remove-${p.id}`}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="font-mono text-[9px] text-subtle">{fmt(p.mm)}</div>
              {isOpen && (
                <div className="font-mono text-[10px] text-muted-foreground space-y-0.5 border-t border-border pt-1.5">
                  {p.values.length === 0 && <div className="text-subtle">No layer values recorded</div>}
                  {p.values.map((v) => (
                    <div key={v.name} className="flex items-center justify-between">
                      <span className="truncate">{v.name}</span>
                      <span className="text-foreground tabular-nums">{Number(v.value).toFixed(3)}</span>
                    </div>
                  ))}
                  {Object.entries(p.labels || {}).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-subtle">
                      <span className="truncate">{k}</span>
                      <span className="truncate text-right">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="h-px bg-border" />

      {/* Lesion max diameter */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          <Move3d size={11} /> lesion max diameter (approx · PCA)
        </div>
        {lesionLayers.length > 1 && (
          <select value={selLesion} onChange={(e) => setSelLesion(e.target.value)} className={selectCls} data-testid="diam-lesion-select">
            <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
            {lesionLayers.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
          </select>
        )}
        <button className={`w-full ${btn}`} onClick={computeDiameter} data-testid="diam-compute" disabled={lesionLayers.length === 0}>
          Measure
        </button>
        {diam && (
          <div className="font-mono text-[10px] text-muted-foreground">
            diameter: <span className="text-foreground">{diam.diameterMM.toFixed(1)} mm</span>
            <span className="text-subtle"> · {diam.voxelCount} vox</span>
          </div>
        )}
      </div>

      <div className="h-px bg-border" />

      {/* Midline shift */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          <AlignVerticalSpaceAround size={11} /> midline shift (landmark-assisted)
        </div>
        <button className={`w-full ${btn}`} onClick={() => setLandmark(crosshairMM ? [...crosshairMM] : null)} data-testid="midline-set">
          Set Landmark @ Crosshair
        </button>
        <div className="font-mono text-[10px] text-muted-foreground">
          landmark: <span className="text-foreground">{fmt(landmark)}</span>
          {ms && (
            <div>
              shift: <span className="text-foreground">{ms.shiftMM.toFixed(1)} mm</span>{" "}
              <span className="text-subtle">({ms.side})</span>
            </div>
          )}
        </div>
        <div className="font-mono text-[9px] text-subtle leading-relaxed">
          place crosshair on a structure expected at the midline (MNI x≈0).
        </div>
      </div>

      <div className="h-px bg-border" />

      {/* Lesion volume estimation */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          <Box size={11} /> lesion volume (voxel count × spacing)
        </div>
        {lesionLayers.length > 1 && (
          <select value={selLesion} onChange={(e) => setSelLesion(e.target.value)} className={selectCls} data-testid="vol-lesion-select">
            <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
            {lesionLayers.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
          </select>
        )}
        <div className="grid grid-cols-2 gap-1">
          <button className={btn} onClick={computeVolume} data-testid="vol-compute" disabled={lesionLayers.length === 0}>
            Lesion Layer
          </button>
          <button className={btn} onClick={computeDrawingVolume} data-testid="vol-compute-drawing">
            Current Drawing
          </button>
        </div>
        {vol && (
          <div className="font-mono text-[10px] text-muted-foreground space-y-0.5">
            <div>
              volume: <span className="text-foreground">{vol.volumeCM3.toFixed(2)} cm³</span>
              <span className="text-subtle"> · {vol.volumeMM3.toFixed(0)} mm³</span>
            </div>
            <div className="text-subtle">
              {vol.voxelCount.toLocaleString()} vox · {vol.spacingMM.map((s) => s.toFixed(2)).join(" × ")} mm
            </div>
          </div>
        )}
      </div>

      <div className="h-px bg-border" />

      {/* ROI intensity statistics */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          <Sigma size={11} /> ROI intensity stats
        </div>
        <div className="space-y-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">mask</div>
          <select value={maskSrc} onChange={(e) => setMaskSrc(e.target.value)} className={selectCls} data-testid="roi-stats-mask">
            {maskOptions.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
          </select>
        </div>
        <div className="space-y-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">intensity source</div>
          <select value={intensitySrc} onChange={(e) => setIntensitySrc(e.target.value)} className={selectCls} data-testid="roi-stats-intensity">
            {intensityOptions.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
          </select>
        </div>
        <button className={`w-full ${btn}`} onClick={computeRoiStats} data-testid="roi-stats-compute">
          Compute stats
        </button>
        {roiStats && (
          <div className="font-mono text-[10px] text-muted-foreground space-y-0.5" data-testid="roi-stats-result">
            <div>mean <span className="text-foreground">{roiStats.mean.toFixed(3)}</span>{" "}
              · sd <span className="text-foreground">{roiStats.sd.toFixed(3)}</span></div>
            <div>min <span className="text-foreground">{roiStats.min.toFixed(3)}</span>{" "}
              · max <span className="text-foreground">{roiStats.max.toFixed(3)}</span></div>
            <div className="text-subtle">{roiStats.count.toLocaleString()} voxels</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MeasurePanel;
