import { describe, expect, test } from "bun:test";
import { stamp } from "../src/log";

describe("hub logging", () => {
  test("formats local timestamps with fixed-width fields", () => {
    const timestamp = stamp(new Date(2026, 6, 30, 9, 14, 2));
    expect(timestamp).toBe("2026-07-30 09:14:02");
    expect(timestamp).toHaveLength(19);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
