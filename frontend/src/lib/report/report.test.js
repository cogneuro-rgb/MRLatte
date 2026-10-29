import { buildReport, buildSummaryReport, glanceText } from "./index";

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  regionName: `Region_${i + 1}`, voxelCount: 100 - i, percentOfLesion: 40 - i * 4, percentOfRegion: 5,
}));
const lesionModel = {
  lesionName: "test.nii.gz",
  generatedAt: "2026-10-23T12:00:00Z",
  volume: { cm3: 6.85, voxelCount: 17077, centroidMM: [18.6, -76.8, -0.2] },
  atlasBreakdowns: [{ atlasId: "aal", atlasName: "AAL · Whole Brain", voxelGrid: "atlas", rows: rows(8) }],
  retinotopyFindings: [{ name: "Polar Angle", kind: "polar", summary: "affects 209°–359° · left hemifield" }],
  provenance: { engine: "lqtpy", version: "0.6.1", threshold: 0.5 },
};

describe("the lesion report", () => {
  const html = buildReport("lesion", { ...lesionModel, lesionFigure: { src: "data:image/png;base64,AA", caption: "Lesion" } });

  test("leads with a short answer: size, side, centre, main regions, visual field", () => {
    const glance = html.match(/<div class="glance">([\s\S]*?)<\/div>/)[1];
    expect(glance).toContain("A 6.85 cm³ lesion in the right hemisphere, centred at 19, -77, 0");
    expect(glance).toContain("Mostly in Region_1 (40%), Region_2 (36%), Region_3 (32%) — AAL.");
    expect(glance).toContain("Visual field: left hemifield.");
    expect(glance.length).toBeLessThan(400);
  });

  test("the PDF's lead is the same text, unescaped (no HTML entities on paper)", () => {
    const model = { ...lesionModel, atlasBreakdowns: [{ ...lesionModel.atlasBreakdowns[0], rows: [
      { regionName: "Region <A> & B", voxelCount: 1, percentOfLesion: 50, percentOfRegion: 1 }] }] };
    expect(glanceText(model)).toContain("Mostly in Region <A> & B (50%) — AAL.");
    expect(buildReport("lesion", model)).toContain("Region &lt;A&gt; &amp; B (50%)");
  });

  test("the figure comes first, and tables show five rows with the rest folded", () => {
    expect(html.indexOf("report-figure")).toBeLessThan(html.indexOf("Measurements"));
    const table = html.slice(html.indexOf("AAL · Whole Brain</div>"));
    const [shown, folded] = table.split('<details class="more">');
    expect(shown.match(/Region_\d+/g)).toEqual(["Region_1", "Region_2", "Region_3", "Region_4", "Region_5"]);
    expect(folded).toContain("3 more regions");
  });
});

describe("the LQTpy Analysis report", () => {
  const html = buildSummaryReport({
    lesionName: "test.nii.gz",
    lesionModel,
    figures: { lesion: { src: "data:image/png;base64,AA", caption: "Lesion" } },
    tractModel: {
      nSelectedStreamlines: 10, nInputStreamlines: 100, pctSelected: 10, tractVolumeCm3: 1, affectedVoxels: 50,
      atlasBreakdowns: [{ atlasName: "HCP1065", rows: [
        { regionName: "IFOF R", hitVoxels: 9, pctRegion: 44, streamlineDensity: 1 },
        { regionName: "Optic radiation R", hitVoxels: 8, pctRegion: 60, streamlineDensity: 1 },
      ] }],
    },
    retino: { intersects: true, finding: "Crosses it.", rows: [{ name: "Optic Radiation (R)", hit_voxels: 1, pct_region: 1, pct_lesion: 1 }] },
    reportFragments: { fragments: { morphometry: "<div>morph</div>" }, unavailable: {}, stylesheet: "" },
  });

  test("is self-contained: no live viewers, no links back to the running app", () => {
    expect(html).not.toMatch(/<iframe/);
    expect(html).not.toMatch(/brainsprite/i);
    expect(html).not.toMatch(/\/api\/summary\/result/);
  });

  test("the lead names the most affected tracts and the visual pathway", () => {
    const glance = html.match(/<div class="glance">([\s\S]*?)<\/div>/)[1];
    expect(glance).toContain("Tracts most affected: Optic radiation R (60%), IFOF R (44%).");
    expect(glance).toContain("It crosses the visual pathway (Optic Radiation (R)).");
  });

  test("the method list names the run's lesion", () => {
    const method = html.slice(html.indexOf('<dl class="method">'));
    expect(method).toContain("<dt>Lesion</dt><dd>test.nii.gz</dd>");
    expect(method).not.toContain("<dt>Retinotopy</dt>");
  });

  test("detailed measures start folded", () => {
    expect(html).toMatch(/<details class="collapsible"><summary>Show morphometry detail<\/summary>/);
  });
});
