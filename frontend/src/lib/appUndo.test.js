import { UNDO_LIMIT, pushUndo, takeUndo } from "./appUndo";

describe("app undo stack", () => {
  test("push puts the newest first and does not mutate the old stack", () => {
    const a = { id: "a" }, b = { id: "b" };
    const one = pushUndo([], a);
    const two = pushUndo(one, b);
    expect(one).toEqual([a]);
    expect(two).toEqual([b, a]);
  });

  test("keeps at most UNDO_LIMIT entries, dropping the oldest", () => {
    let stack = [];
    for (let i = 0; i < UNDO_LIMIT + 5; i++) stack = pushUndo(stack, { i });
    expect(UNDO_LIMIT).toBe(10);
    expect(stack).toHaveLength(UNDO_LIMIT);
    expect(stack[0].i).toBe(UNDO_LIMIT + 4);
    expect(stack[UNDO_LIMIT - 1].i).toBe(5);
  });

  test("take with no entry pops the newest", () => {
    const a = { id: "a" }, b = { id: "b" };
    const taken = takeUndo([b, a]);
    expect(taken.entry).toBe(b);
    expect(taken.rest).toEqual([a]);
  });

  test("take on an empty stack is null", () => {
    expect(takeUndo([])).toBeNull();
  });

  test("take of a given entry also drops everything newer than it", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const taken = takeUndo([c, b, a], b);
    expect(taken.entry).toBe(b);
    expect(taken.rest).toEqual([a]);
  });

  test("take of an entry that is no longer on the stack is null", () => {
    const a = { id: "a" }, gone = { id: "gone" };
    expect(takeUndo([a], gone)).toBeNull();
  });
});
