import { jogSpeed } from "./jog-bar";

describe("jog bar speed", () => {
  test("still in the middle, top speed only at the very end", () => {
    expect(jogSpeed(0, 180)).toBe(0);
    expect(jogSpeed(0.05, 180)).toBe(0);
    expect(jogSpeed(1, 180)).toBeCloseTo(180, 9);
    expect(jogSpeed(-1, 180)).toBeCloseTo(-180, 9);
  });

  test("slow over most of the bar, fast near the ends", () => {
    const at = (f) => jogSpeed(f, 100);
    expect(at(0.25)).toBeLessThan(3);
    expect(at(0.5)).toBeLessThan(10);
    expect(at(0.75)).toBeGreaterThan(20);
    expect(at(0.75)).toBeLessThan(35);
    // each step outward adds more speed than the one before (accelerating)
    expect(at(1) - at(0.75)).toBeGreaterThan(at(0.75) - at(0.5));
    expect(at(0.75) - at(0.5)).toBeGreaterThan(at(0.5) - at(0.25));
  });
});
