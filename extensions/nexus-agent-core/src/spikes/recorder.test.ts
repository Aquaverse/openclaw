import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSpikeRecorder,
  describeError,
  getSharedSpikeRecorder,
  readObservationFile,
} from "./recorder.js";

describe("createSpikeRecorder", () => {
  it("numbers observations in order and filters by spike and item", () => {
    const recorder = createSpikeRecorder();
    recorder.record(2, "hook.before_tool_call", "info");
    recorder.record(2, "tool.execute", "ok");
    recorder.record(3, "blob.naming", "fail");
    expect(recorder.list().map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(recorder.list({ spike: 2 }).map((row) => row.item)).toEqual([
      "hook.before_tool_call",
      "tool.execute",
    ]);
    expect(recorder.list({ spike: 2, item: "tool.execute" })).toHaveLength(1);
  });

  it("turns errors, bigint and functions into JSON-safe data", () => {
    const recorder = createSpikeRecorder();
    const error = Object.assign(new Error("boom"), { code: "E_X" });
    const row = recorder.record(3, "x", "fail", { error, big: 10n, fn: () => 1 });
    expect(row.data).toEqual({ error: { name: "Error", code: "E_X", message: "boom" }, big: "10" });
    expect(() => JSON.stringify(row)).not.toThrow();
  });

  it("clips long strings and deep objects", () => {
    const recorder = createSpikeRecorder();
    const row = recorder.record(1, "x", "info", {
      long: "a".repeat(5000),
      deep: { a: { b: { c: { d: { e: 1 } } } } },
    });
    expect(String(row.data?.long).length).toBeLessThan(700);
    expect(JSON.stringify(row.data?.deep)).toContain("[depth]");
  });

  it("appends JSON lines to the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rec-"));
    try {
      const filePath = path.join(dir, "nested", "observations.jsonl");
      const recorder = createSpikeRecorder({ filePath });
      recorder.record(4, "schedule.handle", "ok", { id: "job-1" });
      recorder.record(4, "schedule.unschedule-by-tag", "ok", { removed: 1 });
      const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
      expect(lines.map((line) => JSON.parse(line).item)).toEqual([
        "schedule.handle",
        "schedule.unschedule-by-tag",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a markdown table and escapes pipes", () => {
    const recorder = createSpikeRecorder();
    recorder.record(3, "blob.naming", "fail", { label: "a|b" });
    const markdown = recorder.toMarkdown(3);
    expect(markdown.split("\n")).toHaveLength(3);
    expect(markdown).toContain("a\\|b");
    expect(recorder.toMarkdown(2).split("\n")).toHaveLength(2);
  });

  it("describeError handles non-errors", () => {
    expect(describeError("plain")).toEqual({ message: "plain" });
  });
});

describe("observation file continuity", () => {
  it("continues seq across recorder instances and records the pid", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rec-"));
    try {
      const filePath = path.join(dir, "observations.jsonl");
      createSpikeRecorder({ filePath }).record(3, "service.start", "ok");
      const second = createSpikeRecorder({ filePath }).record(3, "service.start", "ok");
      expect(second.seq).toBe(2);
      expect(second.pid).toBe(process.pid);
      expect(readObservationFile(filePath).map((row) => row.seq)).toEqual([1, 2]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a torn last line left by kill -9", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rec-"));
    try {
      const filePath = path.join(dir, "observations.jsonl");
      createSpikeRecorder({ filePath }).record(3, "service.start", "ok");
      fs.appendFileSync(filePath, '{"seq":2,"at":"2026');
      expect(readObservationFile(filePath)).toHaveLength(1);
      expect(readObservationFile(path.join(dir, "missing.jsonl"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shares one recorder per file so a reload keeps earlier rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rec-"));
    try {
      const filePath = path.join(dir, "observations.jsonl");
      const first = getSharedSpikeRecorder(filePath);
      first.record(3, "service.stop.end", "ok");
      const afterReload = getSharedSpikeRecorder(filePath);
      expect(afterReload).toBe(first);
      expect(afterReload.list()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
