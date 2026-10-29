import { TextEncoder, TextDecoder } from "util";
import { isWorkspaceFileName, parseWorkspaceBytes, WORKSPACE_EXT, WORKSPACE_VERSION } from "./workspace";

// jsdom (the test browser) lacks these; the app's Chromium has them.
if (typeof global.TextDecoder === "undefined") global.TextDecoder = TextDecoder;

describe("workspace files", () => {
  test("new saves are .mrlatte; old .nvws.json files are still recognised", () => {
    expect(WORKSPACE_EXT).toBe(".mrlatte");
    expect(isWorkspaceFileName("mrlatte-patient-2026-10-23.mrlatte")).toBe(true);
    expect(isWorkspaceFileName("C:\\scans\\old.nvws.json")).toBe(true);
    expect(isWorkspaceFileName("WORKSPACE.MRLATTE")).toBe(true);
    expect(isWorkspaceFileName("scan.nii.gz")).toBe(false);
    expect(isWorkspaceFileName("notes.json")).toBe(false);
    expect(isWorkspaceFileName(null)).toBe(false);
  });

  test("a double-clicked workspace's bytes parse back to the saved object", () => {
    const ws = { version: WORKSPACE_VERSION, label: "MNI152 Template", notes: { "user-1": "left MCA — é" } };
    const bytes = new TextEncoder().encode(JSON.stringify(ws));
    expect(parseWorkspaceBytes(bytes)).toEqual(ws);
  });
});
