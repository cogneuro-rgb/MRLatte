import { needsAttention, runLesionQc, canAutoFix, applyQcFix } from "./lesionQc";
import { getCapabilities, uploadLesion, fetchQc, fetchQcFix } from "@/lib/lesionMetrics";

jest.mock("@/lib/lesionMetrics", () => ({
  getCapabilities: jest.fn(),
  uploadLesion: jest.fn(),
  fetchQc: jest.fn(),
  fetchQcFix: jest.fn(),
}));
jest.mock("@/lib/lesions", () => ({ currentDrawingAsFile: jest.fn() }));

const note = { id: "specks", severity: "info" };
const check = { id: "sparse", severity: "warn", grade: "moderate" };
const problem = { id: "flat", severity: "error", grade: "major" };

describe("needsAttention", () => {
  test("nothing, or Notes only, never interrupts", () => {
    expect(needsAttention(undefined)).toBe(false);
    expect(needsAttention([])).toBe(false);
    expect(needsAttention([note, note])).toBe(false);
  });
  test("a Check or a Problem does", () => {
    expect(needsAttention([note, check])).toBe(true);
    expect(needsAttention([problem])).toBe(true);
  });
});

describe("runLesionQc", () => {
  const file = new File(["x"], "d.nii.gz");
  beforeEach(() => {
    getCapabilities.mockResolvedValue({ available: true, qc_available: true });
    uploadLesion.mockResolvedValue("abc");
  });

  test("drops the `values` finding: pen values are colours in MRLatte", async () => {
    fetchQc.mockResolvedValue({ flags: [{ id: "values", severity: "warn", grade: "minor" }, check], provenance: {} });
    const r = await runLesionQc({ file, mni: true });
    expect(r.flags).toEqual([check]);
    expect(r.lesionId).toBe("abc");
  });

  test("a drawing whose only finding is `values` is clean", async () => {
    fetchQc.mockResolvedValue({ flags: [{ id: "values", severity: "info" }], provenance: {} });
    const r = await runLesionQc({ file, mni: true });
    expect(needsAttention(r.flags)).toBe(false);
  });

  test("still fails open when the backend has no quality check", async () => {
    getCapabilities.mockResolvedValue({ available: true, qc_available: false });
    expect(await runLesionQc({ file, mni: true })).toBeNull();
  });
});

describe("runLesionQc deadline", () => {
  const file = new File(["x"], "d.nii.gz");
  test("a backend that never answers the first request cannot hold Save open", async () => {
    getCapabilities.mockReturnValue(new Promise(() => {}));        // hangs forever
    const started = Date.now();
    expect(await runLesionQc({ file, mni: true, timeoutMs: 30, setupTimeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  test("a slow start is not a hung one: the first check after the backend starts still runs", async () => {
    // capabilities + upload together take longer than the check's own limit
    getCapabilities.mockImplementation(() => new Promise((r) => setTimeout(() => r({ available: true, qc_available: true }), 80)));
    uploadLesion.mockResolvedValue("abc");
    fetchQc.mockResolvedValue({ flags: [{ id: "sparse", severity: "warn" }], provenance: {} });
    const r = await runLesionQc({ file, mni: true, timeoutMs: 40, setupTimeoutMs: 2000 });
    expect(r).not.toBeNull();
    expect(needsAttention(r.flags)).toBe(true);
  });
  test("a hung upload is cut off too", async () => {
    getCapabilities.mockResolvedValue({ available: true, qc_available: true });
    uploadLesion.mockReturnValue(new Promise(() => {}));
    expect(await runLesionQc({ file, mni: true, timeoutMs: 30, setupTimeoutMs: 30 })).toBeNull();
  });
});

describe("lqtpy 0.6.0 extras", () => {
  const file = new File(["x"], "d.nii.gz");
  beforeEach(() => {
    getCapabilities.mockResolvedValue({ available: true, qc_available: true });
    uploadLesion.mockResolvedValue("abc");
  });

  test("lqtpy is always told the label values are pen colours", async () => {
    fetchQc.mockResolvedValue({ flags: [], provenance: {} });
    await runLesionQc({ file, mni: true });
    expect(fetchQc.mock.calls.at(-1)[0].context).toEqual({ labels_are_colours: true });
  });

  test("the drawing plane from the viewer is added to that", async () => {
    fetchQc.mockResolvedValue({ flags: [], provenance: {} });
    const viewerRef = { current: { getDrawingContext: () => ({ drawing_axis: 2, source: "drawn" }) } };
    await runLesionQc({ file, viewerRef, mni: true });
    expect(fetchQc.mock.calls.at(-1)[0].context).toEqual({ labels_are_colours: true, drawing_axis: 2, source: "drawn" });
  });

  test("lqtpy's own needs_attention decides when it is given", async () => {
    fetchQc.mockResolvedValue({ flags: [{ id: "specks", severity: "info" }], needs_attention: false, provenance: {} });
    expect((await runLesionQc({ file, mni: true })).needsAttention).toBe(false);
    fetchQc.mockResolvedValue({ flags: [{ id: "flat", severity: "error" }], needs_attention: true, provenance: {} });
    expect((await runLesionQc({ file, mni: true })).needsAttention).toBe(true);
  });

  test("...but never because of a finding MRLatte hides", async () => {
    fetchQc.mockResolvedValue({ flags: [{ id: "values", severity: "warn" }], needs_attention: true, provenance: {} });
    expect((await runLesionQc({ file, mni: true })).needsAttention).toBe(false);
  });

  test("an older lqtpy that says nothing falls back to the findings", async () => {
    fetchQc.mockResolvedValue({ flags: [{ id: "flat", severity: "warn" }], provenance: {} });
    expect((await runLesionQc({ file, mni: true })).needsAttention).toBe(true);
  });
});

describe("one-click fixes", () => {
  test("only removals that lqtpy says it can fix get a button", () => {
    expect(canAutoFix({ id: "specks", severity: "warn", fix: { call: "qc.clean" } })).toBe(true);
    expect(canAutoFix({ id: "strokes", severity: "info", fix: { call: "qc.clean" } })).toBe(true);
    expect(canAutoFix({ id: "specks", severity: "warn", fix: null })).toBe(false);          // older lqtpy: no hint
    expect(canAutoFix({ id: "sparse_slices", severity: "error", fix: { call: "qc.repair_gaps" } })).toBe(false); // adds voxels
    expect(canAutoFix({ id: "holes", severity: "warn", fix: { call: "qc.fix" } })).toBe(false);
  });

  test("the removal mask goes to the viewer, with the drawing context", async () => {
    fetchQcFix.mockResolvedValue({ voxels_removed: 5, removed_mask: btoa("mask-bytes") });
    const removeVoxelsFromMask = jest.fn().mockResolvedValue(5);
    const viewerRef = { current: { removeVoxelsFromMask, getDrawingContext: () => ({ drawing_axis: 2 }) } };
    expect(await applyQcFix({ viewerRef, lesionId: "abc", findingId: "specks" })).toBe(5);
    expect(fetchQcFix.mock.calls.at(-1)[0]).toEqual({
      lesionId: "abc", findingIds: ["specks"], context: { labels_are_colours: true, drawing_axis: 2 },
    });
    const file = removeVoxelsFromMask.mock.calls[0][0];
    expect(file.name).toBe("qc_fix_removed.nii.gz");
    expect(file.size).toBe("mask-bytes".length);
  });

  test("nothing to remove does not touch the drawing", async () => {
    fetchQcFix.mockResolvedValue({ voxels_removed: 0, removed_mask: "" });
    const removeVoxelsFromMask = jest.fn();
    expect(await applyQcFix({ viewerRef: { current: { removeVoxelsFromMask } }, lesionId: "abc", findingId: "specks" })).toBe(0);
    expect(removeVoxelsFromMask).not.toHaveBeenCalled();
  });

  test("a drawing that no longer fits is an error, not a silent no-op", async () => {
    fetchQcFix.mockResolvedValue({ voxels_removed: 3, removed_mask: btoa("x") });
    const viewerRef = { current: { removeVoxelsFromMask: jest.fn().mockResolvedValue(null) } };
    await expect(applyQcFix({ viewerRef, lesionId: "abc", findingId: "specks" })).rejects.toThrow(/could not take the fix/);
  });
});
