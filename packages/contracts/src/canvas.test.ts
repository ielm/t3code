import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { CanvasManifest, CanvasName, CanvasRelativePath } from "./canvas.ts";

const isName = Schema.is(CanvasName);
const isPath = Schema.is(CanvasRelativePath);
const decodeManifest = Schema.decodeUnknownSync(CanvasManifest);

describe("canvas names and paths", () => {
  it("accepts only names that are safe as one folder segment", () => {
    expect(["aws-dashboard", "a", "2fa"].every(isName)).toBe(true);
    expect(["", "-lead", "Upper", "a/b", "..", "a.b", "a b", "x".repeat(65)].some(isName)).toBe(
      false,
    );
  });

  it("rejects every path that could leave the canvas folder", () => {
    expect(["index.html", "parts/chart.js", "a/b/c.css", ".hidden", "a..b"].every(isPath)).toBe(
      true,
    );
    for (const path of [
      "/etc/passwd",
      "../secret",
      "a/../../b",
      "a/..",
      "./a",
      "a/./b",
      "a//b",
      "C:/x",
      "a\\b",
      "",
    ]) {
      expect(isPath(path), path).toBe(false);
    }
  });
});

describe("canvas.json", () => {
  it("reads declared functions and bounds their timeout", () => {
    const manifest = decodeManifest({
      title: "AWS",
      functions: {
        listInstances: { command: ["aws", "ec2", "describe-instances"], kind: "read" },
        restart: { command: ["bash", "functions/restart.sh"], kind: "change", timeoutSeconds: 60 },
      },
    });
    expect(manifest.functions?.restart?.kind).toBe("change");
    expect(() =>
      decodeManifest({ title: "x", functions: { f: { command: [], kind: "read" } } }),
    ).toThrow();
    expect(() =>
      decodeManifest({
        title: "x",
        functions: { f: { command: ["a"], kind: "read", timeoutSeconds: 301 } },
      }),
    ).toThrow();
    expect(() =>
      decodeManifest({ title: "x", functions: { "bad-name": { command: ["a"], kind: "read" } } }),
    ).toThrow();
  });
});
