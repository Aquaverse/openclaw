import { describe, expect, it } from "vitest";
import { likePairs, sameAsk } from "./likeness.js";

describe("sameAsk", () => {
  it("matches the same sentence despite spacing, case and punctuation", () => {
    expect(sameAsk("把报价单发给客户。", "把报价单 发给客户")).toBe(true);
    expect(sameAsk("Send the quote to ACME", "send the quote to acme!")).toBe(true);
  });

  it("matches a light rewording by word overlap", () => {
    expect(sameAsk("周五前把季度报价单发给客户", "周五之前把季度报价单发给客户")).toBe(true);
  });

  it("does not match different asks or very short text", () => {
    expect(sameAsk("把报价单发给客户", "预订下周的会议室")).toBe(false);
    expect(sameAsk("报价", "报价")).toBe(false);
  });
});

describe("likePairs", () => {
  it("pairs each commitment once and honours the limit", () => {
    const source = [
      { id: "s1", text: "把报价单发给客户" },
      { id: "s2", text: "把报价单发给客户" },
      { id: "s3", text: "预订下周的会议室" },
    ];
    const target = [{ id: "t1", text: "把报价单发给客户。" }];
    const pairs = likePairs(source, target, 5);
    expect(pairs.map((p) => [p.sourceId, p.targetId])).toEqual([["s1", "t1"]]);
    expect(likePairs(source, [...target, { id: "t2", text: "把报价单发给客户" }], 1)).toHaveLength(
      1,
    );
  });
});
