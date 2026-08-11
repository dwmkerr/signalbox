import { describe, expect, test } from "bun:test";
import { iTermOrigin } from "../src/iterm";

describe("iTermOrigin", () => {
  test("extracts the stable GUID from iTerm's layout-prefixed session id", () => {
    expect(iTermOrigin({
      TERM_PROGRAM: "iTerm.app",
      ITERM_SESSION_ID: "w0t1p0:SESSION-GUID",
    })).toEqual({ kind: "iterm", iterm: { session: "SESSION-GUID" } });
  });

  test("accepts an unprefixed session GUID", () => {
    expect(iTermOrigin({
      TERM_PROGRAM: "iTerm.app",
      ITERM_SESSION_ID: "SESSION-GUID",
    })).toEqual({ kind: "iterm", iterm: { session: "SESSION-GUID" } });
  });

  test("does not claim other terminals or an iTerm session with no id", () => {
    expect(iTermOrigin({ TERM_PROGRAM: "Apple_Terminal", ITERM_SESSION_ID: "SESSION-GUID" })).toBeNull();
    expect(iTermOrigin({ TERM_PROGRAM: "iTerm.app" })).toBeNull();
    expect(iTermOrigin({ TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t1p0:" })).toBeNull();
  });
});
