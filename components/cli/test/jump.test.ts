import { describe, expect, test } from "bun:test";
import { checkOpenURL } from "../src/jump";

describe("checkOpenURL", () => {
  test("allows web schemes", () => {
    expect(checkOpenURL("https://github.com/x/y")).toBeNull();
    expect(checkOpenURL("http://localhost:3000")).toBeNull();
  });
  test("refuses everything that could execute", () => {
    expect(checkOpenURL("file:///etc/passwd")).toContain("refusing");
    expect(checkOpenURL("x-apple.systempreferences:")).toContain("refusing");
    expect(checkOpenURL("javascript:alert(1)")).toContain("refusing");
    expect(checkOpenURL("-a Calculator")).toContain("flag");
    expect(checkOpenURL("not a url")).toContain("refusing");
  });
});
