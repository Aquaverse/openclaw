// The hook helpers: which user turns of an event count, and which message is only the page's opener.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { tr } from "../i18n.js";
import { isCreationOpener, userTurnsFrom } from "./goal-hook.js";

describe("userTurnsFrom", () => {
  it("takes user messages from history and the current prompt once", () => {
    const turns = userTurnsFrom({
      messages: [
        { role: "user", id: "m1", content: "first" },
        { role: "assistant", id: "a1", content: "question?" },
        { role: "user", content: [{ type: "text", text: "second" }, { type: "image" }] },
      ],
      prompt: "third",
      currentUserMessageId: "m3",
    });
    assert.deepEqual(
      turns.map((t) => t.text),
      ["first", "second", "third"],
    );
    assert.equal(turns[0]?.key, "id:m1");
    assert.equal(turns[2]?.key, "id:m3");
    assert.match(turns[1]?.key ?? "", /^h:/u);
  });

  it("does not double count a prompt that is already the last history message", () => {
    const turns = userTurnsFrom({
      messages: [{ role: "user", id: "m1", content: "same" }],
      prompt: " same ",
    });
    assert.equal(turns.length, 1);
  });

  it("survives an event without messages or with odd shapes", () => {
    assert.deepEqual(userTurnsFrom(undefined), []);
    assert.deepEqual(userTurnsFrom({ messages: "x", prompt: 3 }), []);
    assert.deepEqual(userTurnsFrom({ messages: [null, 4, { role: "user", content: 5 }] }), []);
  });
});

describe("isCreationOpener", () => {
  it("recognises the page's fixed openers in both languages and the sub-goal opener by shape", () => {
    for (const lang of ["zh", "en"] as const) {
      for (const key of [
        "goal.opener.finance",
        "goal.opener.interests",
        "goal.opener.something_else",
      ] as const) {
        assert.equal(isCreationOpener(tr(lang, key)), true, `${lang} ${key}`);
      }
      assert.equal(
        isCreationOpener(tr(lang, "goal.opener.sub", { title: "Become a better cook" })),
        true,
      );
    }
  });

  it("does not take the user's own sentence for an opener", () => {
    assert.equal(isCreationOpener("I want to save a million in a year"), false);
    assert.equal(isCreationOpener(""), false);
  });
});
