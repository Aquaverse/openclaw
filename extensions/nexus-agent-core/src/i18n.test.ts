// Page text: both catalogs are complete and consistent, locale resolution, and escaping of what is inserted.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { allMessageKeys, langFromAcceptLanguage, resolveLang, tr, trHtml } from "./i18n.js";
import { esc } from "./ui-render.js";

describe("page text catalogs", () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((m) => String(m[1])).toSorted();

  it("has text in both languages for every key, with the same placeholders", () => {
    for (const key of allMessageKeys()) {
      const zh = tr("zh", key);
      const en = tr("en", key);
      assert.ok(zh.length > 0 && en.length > 0, key);
      assert.deepEqual(placeholders(zh), placeholders(en), `${key}: placeholders differ`);
    }
  });

  it("shows English where the Chinese text would be, never Chinese in English", () => {
    for (const key of allMessageKeys()) {
      assert.ok(!/[一-鿿]/.test(tr("en", key)), `${key} has Chinese in the English text`);
    }
  });

  it("fills placeholders and leaves unknown ones alone", () => {
    assert.equal(tr("en", "title.task", { id: "T1" }), "Task T1");
    assert.equal(tr("zh", "title.task", { id: "T1" }), "事项 T1");
    assert.equal(
      tr("en", "pager.summary", { total: 45, first: 1, last: 20, page: 1, pages: 3 }),
      "45 in total, showing 1–20 (page 1 of 3)",
    );
    assert.equal(tr("en", "title.task"), "Task {id}");
  });

  it("resolves a locale tag: Chinese to Chinese, other known or unknown tags to English, none to Chinese", () => {
    for (const tag of ["zh", "zh-CN", "zh-Hans", "zh_TW", "ZH-hk"]) {
      assert.equal(resolveLang(tag), "zh", tag);
    }
    for (const tag of ["en", "en-US", "de", "ar", "ja-JP", "xx"]) {
      assert.equal(resolveLang(tag), "en", tag);
    }
    assert.equal(resolveLang(undefined), "zh");
    assert.equal(resolveLang(""), "zh");
    assert.equal(resolveLang(null), "zh");
  });

  it("picks the best Accept-Language entry by quality, then order", () => {
    assert.equal(langFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh");
    assert.equal(langFromAcceptLanguage("en-US,en;q=0.9,zh;q=0.8"), "en");
    assert.equal(langFromAcceptLanguage("en;q=0.5, zh-CN;q=0.9"), "zh");
    assert.equal(langFromAcceptLanguage("de-DE,de;q=0.9"), "en");
    assert.equal(langFromAcceptLanguage("*"), "zh");
    assert.equal(langFromAcceptLanguage("en;q=0, zh;q=0.1"), "zh");
    assert.equal(langFromAcceptLanguage(undefined), "zh");
    assert.equal(langFromAcceptLanguage(""), "zh");
  });

  it("escapes the catalog text but inserts the given markup as is", () => {
    const html = trHtml("en", "hint.decisionReadOnly", esc, {
      code: "<code>nexus.decision.resolve</code>",
    });
    assert.ok(html.includes("<code>nexus.decision.resolve</code>"));
    assert.ok(html.includes("View only here."));
    // A placeholder with no markup given stays visible instead of vanishing.
    assert.ok(trHtml("en", "hint.decisionReadOnly", esc).includes("{code}"));
  });
});
