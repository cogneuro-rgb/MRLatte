import { isMniTemplateGrid } from "./mniGrid";

const aff = (sx, sy, sz, ox, oy, oz) => [[sx, 0, 0, ox], [0, sy, 0, oy], [0, 0, sz, oz], [0, 0, 0, 1]];

describe("isMniTemplateGrid", () => {
  test("the standard templates, however they are stored", () => {
    expect(isMniTemplateGrid(aff(-1, 1, 1, 90, -126, -72), [182, 218, 182])).toBe(true);   // FSL 1 mm, x flipped
    expect(isMniTemplateGrid(aff(-2, 2, 2, 90, -126, -72), [91, 109, 91])).toBe(true);     // FSL 2 mm
    expect(isMniTemplateGrid(aff(2, 2, 2, -90, -126, -72), [91, 109, 91])).toBe(true);     // same grid stored RAS
    expect(isMniTemplateGrid(aff(1, 1, 1, -96, -132, -78), [193, 229, 193])).toBe(true);   // 2009c 1 mm
    expect(isMniTemplateGrid(aff(2, 2, 2, -96, -132, -78), [97, 115, 97])).toBe(true);     // 2009c 2 mm
  });

  test("a native scan of similar size is not mistaken for one", () => {
    expect(isMniTemplateGrid(aff(1, 1, 1, -88, -120, -70), [176, 256, 256])).toBe(false);
    expect(isMniTemplateGrid(aff(-1, 1, 1, 91.5, -126, -72), [182, 218, 182])).toBe(false);  // right size, 1.5 mm off
    expect(isMniTemplateGrid(aff(0.9, 0.9, 0.9, -81, -113, -65), [182, 218, 182])).toBe(false);
  });

  test("a template moved by hand no longer counts", () => {
    expect(isMniTemplateGrid(aff(-2, 2, 2, 100, -126, -72), [91, 109, 91])).toBe(false);
  });

  test("bad input is a plain no", () => {
    expect(isMniTemplateGrid(null, [91, 109, 91])).toBe(false);
    expect(isMniTemplateGrid(aff(2, 2, 2, 0, 0, 0), [1, 1, 1])).toBe(false);
    expect(isMniTemplateGrid(aff(NaN, 2, 2, 0, 0, 0), [91, 109, 91])).toBe(false);
  });
});
