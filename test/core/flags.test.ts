import { describe, expect, it } from "vitest";
import { FlagError, parseFlags } from "../../src/core/flags.ts";

const SPEC = { values: ["--project", "--root"], bools: ["--once", "--dry-run"] } as const;

describe("parseFlags (--key=value only)", () => {
  it("reads --key=value and bare booleans", () => {
    const r = parseFlags(["--project=webtarsthree", "--once", "--root=/tmp/x"], SPEC, "t");
    expect(r.values).toEqual({ "--project": "webtarsthree", "--root": "/tmp/x" });
    expect([...r.bools]).toEqual(["--once"]);
    expect(r.positionals).toEqual([]);
  });

  it("keeps everything after the first '=' as the value", () => {
    expect(parseFlags(["--root=a=b"], SPEC, "t").values["--root"]).toBe("a=b");
  });

  it("rejects the old space form, naming the exact replacement", () => {
    expect(() => parseFlags(["--project", "webtarsthree"], SPEC, "t")).toThrow(FlagError);
    expect(() => parseFlags(["--project", "webtarsthree"], SPEC, "t")).toThrow(
      't: --project takes its value after "=": use --project=webtarsthree',
    );
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseFlags(["--project"], SPEC, "t")).toThrow("t: --project needs a value: use --project=<value>");
    expect(() => parseFlags(["--project", "--once"], SPEC, "t")).toThrow(/--project needs a value/);
    expect(() => parseFlags(["--project="], SPEC, "t")).toThrow(/--project needs a value/);
  });

  it("rejects a value on a boolean flag", () => {
    expect(() => parseFlags(["--once=true"], SPEC, "t")).toThrow('t: --once takes no value (got "--once=true")');
  });

  it("rejects a flag given twice", () => {
    expect(() => parseFlags(["--project=a", "--project=b"], SPEC, "t")).toThrow("t: --project given twice");
    expect(() => parseFlags(["--once", "--once"], SPEC, "t")).toThrow("t: --once given twice");
  });

  it("rejects unknown flags and, unless allowed, positionals", () => {
    expect(() => parseFlags(["--onec"], SPEC, "t")).toThrow('t: unknown argument "--onec"');
    expect(() => parseFlags(["--proj=x"], SPEC, "t")).toThrow('t: unknown argument "--proj=x"');
    expect(() => parseFlags(["extra"], SPEC, "t")).toThrow('t: unknown argument "extra"');
  });

  it("collects positionals in order when allowed", () => {
    const r = parseFlags(["get", "--once", "TARS-1"], { ...SPEC, positionals: true }, "t");
    expect(r.positionals).toEqual(["get", "TARS-1"]);
  });
});
