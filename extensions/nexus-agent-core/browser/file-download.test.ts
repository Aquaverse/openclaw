import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_CHUNK_BYTES,
  DownloadError,
  describeDownloadError,
  fetchFileBytes,
  sha256Hex,
  verifyBytes,
} from "./file-download.ts";

/** The error a promise rejects with (so the tests do not depend on `.rejects` support). */
async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A fake gateway holding `content`: serves nexus.vault.read in the ranges asked for, at most `cap` bytes per reply. */
function gateway(content: Uint8Array, options: { cap?: number; hash?: string } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const request = async (method: string, params?: Record<string, unknown>) => {
    expect(method).toBe("nexus.vault.read");
    calls.push(params ?? {});
    const offset = Number(params?.offset ?? 0);
    const length = Math.min(Number(params?.length ?? 0), options.cap ?? Number.MAX_SAFE_INTEGER);
    const chunk = content.subarray(offset, offset + length);
    return {
      dataBase64: b64(chunk),
      size: content.length,
      eof: offset + chunk.length >= content.length,
      ...(options.hash ? { contentHash: options.hash } : {}),
    };
  };
  return { request: request as never, calls };
}

describe("file download", () => {
  it("reads a file larger than one reply in several chunks and reports progress", async () => {
    const content = new Uint8Array(2500).map((_, index) => index % 251);
    const g = gateway(content, { cap: 1000 });
    const progress: number[] = [];
    const out = await fetchFileBytes(g.request, "VF1", {
      onProgress: (done) => progress.push(done),
    });
    expect(Buffer.from(out.bytes).equals(Buffer.from(content))).toBe(true);
    expect(g.calls.map((call) => call.offset)).toEqual([0, 1000, 2000]);
    expect(g.calls[0]).toEqual({ fileId: "VF1", offset: 0, length: DOWNLOAD_CHUNK_BYTES });
    expect(progress).toEqual([1000, 2000, 2500]);
  });

  it("asks for an older version only when one is named", async () => {
    const g = gateway(new Uint8Array([1, 2, 3]));
    await fetchFileBytes(g.request, "VF1", { version: 2 });
    expect(g.calls[0]).toMatchObject({ version: 2 });
    const current = gateway(new Uint8Array([1]));
    await fetchFileBytes(current.request, "VF1");
    expect("version" in current.calls[0]!).toBe(false);
  });

  it("reads an empty file without a second request", async () => {
    const g = gateway(new Uint8Array());
    const out = await fetchFileBytes(g.request, "VF1");
    expect(out.bytes.length).toBe(0);
    expect(g.calls.length).toBe(1);
  });

  it("refuses a file over the limit before reading its bytes", async () => {
    const g = gateway(new Uint8Array(50));
    expect(await failure(fetchFileBytes(g.request, "VF1", { maxBytes: 10 }))).toMatchObject({
      code: "tooBig",
      detail: { size: 50 },
    });
    expect(g.calls.length).toBe(1);
  });

  it("stops when the file changes size between chunks, or the gateway cuts the data short", async () => {
    let calls = 0;
    const changing = async () => {
      calls += 1;
      return { dataBase64: b64(new Uint8Array(4)), size: calls === 1 ? 10 : 12, eof: false };
    };
    expect(await failure(fetchFileBytes(changing as never, "VF1"))).toMatchObject({
      code: "changed",
    });
    const short = async () => ({ dataBase64: b64(new Uint8Array(4)), size: 10, eof: true });
    expect(await failure(fetchFileBytes(short as never, "VF1"))).toMatchObject({ code: "short" });
    const empty = async () => ({ dataBase64: "", size: 10, eof: false });
    expect(await failure(fetchFileBytes(empty as never, "VF1"))).toMatchObject({ code: "short" });
  });

  it("checks the recorded hash and refuses bytes that do not match", async () => {
    const bytes = new TextEncoder().encode("hello vault");
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await sha256Hex(bytes)).toBe(expected);
    await verifyBytes(bytes, expected);
    await verifyBytes(bytes, undefined);
    expect(await failure(verifyBytes(bytes, "0".repeat(64)))).toMatchObject({ code: "mismatch" });
  });

  it("describes each failure in the console's language", () => {
    const size = { size: 100 };
    expect(describeDownloadError("zh", new DownloadError("mismatch", "x"), size)).toContain(
      "哈希不一致",
    );
    expect(describeDownloadError("en", new DownloadError("mismatch", "x"), size)).toContain(
      "do not match",
    );
    expect(
      describeDownloadError(
        "en",
        new DownloadError("tooBig", "x", { size: 300 * 1024 * 1024 }),
        size,
      ),
    ).toContain("256 MiB");
    expect(describeDownloadError("en", new Error("boom"), size)).toBe("Download failed: boom");
  });
});
