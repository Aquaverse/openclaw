// G4: the skills that ship with the plugin (skills/goals, skills/moneywise). They carry domain judgement only, so the checks
// here are structural: they are packaged and declared, every file they point at exists, every tool they name is real, and they
// stay free of anything that belongs to Nexus' rules or to another product. What the Agent does with them is judged by the
// scenarios in docs/nexus-agent-core-goals-eval-scenarios.md, not here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import {
  GOAL_CREATION_REMINDER,
  goalCreationGuide,
  goalReviewNudge,
  NEXUS_GOAL_PROTOCOL,
} from "./goal/goal-prompt.js";

const root = path.resolve(import.meta.dirname, "..");
const skillsRoot = path.join(root, "skills");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8")) as {
  skills?: string[];
  contracts: { tools: string[] };
};
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  files?: string[];
};

const skillNames = fs
  .readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(skillsRoot, ...parts), "utf8");

const referenceFiles = (skill: string): string[] => {
  const dir = path.join(skillsRoot, skill, "references");
  return fs.existsSync(dir) ? fs.readdirSync(dir).toSorted() : [];
};

const allFiles = (): { skill: string; file: string; text: string }[] =>
  skillNames.flatMap((skill) => [
    { skill, file: "SKILL.md", text: read(skill, "SKILL.md") },
    ...referenceFiles(skill).map((file) => ({
      skill,
      file: `references/${file}`,
      text: read(skill, "references", file),
    })),
  ]);

describe("Goals skills: packaging", () => {
  it("ships exactly the goals and moneywise skills, declared in the manifest and in the package files", () => {
    assert.deepEqual(skillNames, ["goals", "moneywise"]);
    assert.deepEqual(manifest.skills, ["./skills"]);
    assert.ok(
      packageJson.files?.includes("skills/**"),
      "package.json files must include skills/**",
    );
  });

  it("gives each skill a matching name and a short trigger description", () => {
    for (const skill of skillNames) {
      const text = read(skill, "SKILL.md");
      const front = /^---\n([\s\S]*?)\n---\n/u.exec(text);
      assert.ok(front, `${skill}: frontmatter missing`);
      const name = /^name:\s*(.+)$/mu.exec(front[1] ?? "")?.[1]?.trim();
      const description = /^description:\s*"(.+)"$/mu.exec(front[1] ?? "")?.[1];
      assert.equal(name, skill);
      assert.ok(
        description && description.length >= 40 && description.length <= 400,
        `${skill}: description length`,
      );
    }
  });

  it("keeps the thin entry thin", () => {
    assert.ok(read("goals", "SKILL.md").length < 6000);
    assert.ok(read("moneywise", "SKILL.md").length < 2000);
    for (const { skill, file, text } of allFiles()) {
      assert.ok(text.length < 6000, `${skill}/${file} is too long to read on demand`);
    }
  });
});

describe("Goals skills: references", () => {
  it("points only at files that exist, and every reference file is pointed at", () => {
    const pointed = new Set<string>();
    for (const { skill, text } of allFiles()) {
      for (const match of text.matchAll(/`?(references\/[a-z-]+\.md)`?/gu)) {
        const target = match[1] ?? "";
        // A pointer names either this skill's own file or, next to "moneywise", the moneywise one.
        const lineStart = text.lastIndexOf("\n", match.index ?? 0) + 1;
        const prefix = text.slice(lineStart, match.index);
        const owner = prefix.endsWith("`moneywise` skill's ") ? "moneywise" : skill;
        assert.ok(
          fs.existsSync(path.join(skillsRoot, owner, target)),
          `${skill} points at ${owner}/${target}, which does not exist`,
        );
        pointed.add(`${owner}/${target}`);
      }
    }
    for (const skill of skillNames) {
      for (const file of referenceFiles(skill)) {
        assert.ok(
          pointed.has(`${skill}/references/${file}`),
          `${skill}/references/${file} is never pointed at`,
        );
      }
    }
  });

  it("routes finance goals from goals to moneywise and covers the three v1 categories", () => {
    const entry = read("goals", "SKILL.md");
    assert.match(entry, /finance: read the `moneywise` skill's `references\/goals\.md`/u);
    assert.match(entry, /interests: `references\/interests\.md`/u);
    assert.match(entry, /something_else.*`references\/other\.md`/u);
    assert.deepEqual(referenceFiles("goals"), ["interests.md", "other.md"]);
    assert.deepEqual(referenceFiles("moneywise"), ["goals.md"]);
  });
});

describe("Goals skills: content limits", () => {
  const toolNames = new Set(manifest.contracts.tools);

  it("names only tools that exist", () => {
    for (const { skill, file, text } of allFiles()) {
      for (const match of text.matchAll(/\bnexus_[a-z_]+\b/gu)) {
        assert.ok(
          toolNames.has(match[0]),
          `${skill}/${file} names ${match[0]}, which is not a Nexus tool`,
        );
      }
    }
    // The Agent has no tool to complete, confirm or delete a goal; the skills must not suggest one.
    for (const { skill, file, text } of allFiles()) {
      assert.doesNotMatch(
        text,
        /nexus_goal_(complete|confirm|delete|purge|reopen|update)/u,
        `${skill}/${file}`,
      );
    }
  });

  it("stays English and free of another product's tools and paths", () => {
    for (const { skill, file, text } of allFiles()) {
      assert.doesNotMatch(text, /[一-鿿]/u, `${skill}/${file} has Chinese text`);
      assert.doesNotMatch(
        text,
        /plaid|muse\.|user_goal|MEMORY\.md|GOAL\.md|workspace\/goals|\/opt\/hatch/iu,
        `${skill}/${file}`,
      );
    }
  });

  it("does not define the persistent contract (limits, statuses, grants) in skill text", () => {
    for (const { skill, file, text } of allFiles()) {
      assert.doesNotMatch(
        text,
        /\b\d+ active goals?\b|creation grant|goal_review_plans|nexus\.goal\./iu,
        `${skill}/${file}`,
      );
    }
  });

  it("keeps the finance safety limits the creation guide has", () => {
    const finance = read("moneywise", "references", "goals.md");
    const creation = goalCreationGuide("finance");
    for (const text of [finance, creation]) {
      assert.match(text, /personalised investment, tax, legal/iu);
      assert.match(text, /approval/iu);
      assert.match(text, /securities, crypto trades, tax strategies/iu);
    }
    assert.match(finance, /ID, card, account or membership numbers/u);
    assert.match(finance, /Never shame|shame/iu);
  });
});

describe("Goals skills: wiring in the prompts", () => {
  it("tells the Agent every turn to read the goals skill outside the creation chat", () => {
    assert.match(NEXUS_GOAL_PROTOCOL, /read the `goals` skill first if it is listed/u);
    assert.match(NEXUS_GOAL_PROTOCOL, /`moneywise` skill/u);
  });

  it("makes a look-back read the goals skill after the user agreed, not before", () => {
    const text = goalReviewNudge([
      { goalId: "G1", title: "Save for a house", category: "finance" },
    ]);
    assert.ok(text);
    const agree = text.indexOf("If they agree:");
    const skill = text.indexOf("`goals` skill");
    assert.ok(agree >= 0 && skill > agree, "the skill is read only on the agree branch");
  });

  it("says the goal tools are direct tools, so a search inside exec finding nothing is not a reason to give up", () => {
    // Seen in the second Mac trial (Codex runtime): the model ran everything through exec, found no nexus_goal_create in
    // the exec tool list, and told the user the tool was not loaded. The tool was in the direct namespace all along.
    for (const category of ["finance", "interests", "something_else"] as const) {
      assert.match(goalCreationGuide(category), /direct tools: they do not show up in the exec/u);
      assert.match(goalCreationGuide(category), /never tell the user the tool is not loaded/iu);
    }
    assert.match(GOAL_CREATION_REMINDER, /do not look for it inside exec/u);
    assert.match(NEXUS_GOAL_PROTOCOL, /direct tools: call them as ordinary tool calls/u);
  });

  it("keeps the creation chat out of the skills: it already carries its own guide", () => {
    // Seen in the first Mac trial (S13): the host tells the model to read a matching skill first, so the guide and the
    // reminder beside the user's message must say no, and the skill descriptions must exclude this chat.
    for (const category of ["finance", "interests", "something_else"] as const) {
      assert.match(
        goalCreationGuide(category),
        /Do NOT read the `goals` or `moneywise` skills here/u,
      );
    }
    assert.match(GOAL_CREATION_REMINDER, /Do not read the goals or moneywise skills in this chat/u);
    for (const skill of skillNames) {
      assert.match(
        read(skill, "SKILL.md"),
        /not for the chat opened from the Goals page to create a goal/iu,
      );
    }
  });
});
