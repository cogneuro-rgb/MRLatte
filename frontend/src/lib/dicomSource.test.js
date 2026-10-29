import { dicomSourceOf } from "./dicomSource";

const withPaths = (paths) => {
  window.mrlatte = { getPathForFile: (f) => f.p };
  return paths.map((p) => ({ p }));
};
afterEach(() => { delete window.mrlatte; });

describe("where a DICOM base came from", () => {
  test("a folder of files, including subfolders", () => {
    expect(dicomSourceOf(withPaths(["C:\\scans\\study1\\a.dcm", "C:\\scans\\study1\\s2\\b.dcm"])))
      .toEqual({ type: "folder", path: "C:\\scans\\study1" });
  });
  test("a zip", () => {
    expect(dicomSourceOf(withPaths(["D:\\in\\study.zip"]))).toEqual({ type: "zip", path: "D:\\in\\study.zip" });
  });
  test("a network share keeps its leading double backslash", () => {
    expect(dicomSourceOf(withPaths(["\\\\srv\\share\\pt\\1.dcm", "\\\\srv\\share\\pt\\2.dcm"])))
      .toEqual({ type: "folder", path: "\\\\srv\\share\\pt" });
  });
  test("a drive root", () => {
    expect(dicomSourceOf(withPaths(["E:\\one.dcm", "E:\\two.dcm"]))).toEqual({ type: "folder", path: "E:\\" });
  });
  test("no paths (browser build) gives nothing", () => {
    expect(dicomSourceOf([{}, {}])).toBeNull();
  });
});
