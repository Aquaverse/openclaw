const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateLinks } = require("./validate-run.cjs");
function sample() {
  return {
    m: {
      profile: "standard",
      run_status: "complete",
      final_verifications: {
        finding: {
          verdict: "confirmed",
          phase3_agent_id: "verifier-1",
          phase5_agent_id: "verifier-2",
        },
      },
    },
    l: [
      {
        status: "candidate",
        agent_id: "hunter",
        prior_status: "new",
        result_fingerprints: ["finding"],
        final_dispositions: { finding: "confirmed" },
      },
    ],
    f: [{ fingerprint: "finding", verdict: "confirmed" }],
  };
}
function errors(x) {
  return validateLinks(x.m, x.l, x.f);
}
test("consistent finalized links pass", () => assert.deepEqual(errors(sample()), []));
test("finding must have current ledger link", () => {
  const x = sample();
  x.l = [];
  assert.ok(errors(x).length);
});
test("ledger and verification verdicts must match", () => {
  const x = sample();
  x.l[0].final_dispositions.finding = "rejected";
  assert.ok(errors(x).length);
});
test("complete cannot omit candidates or leave units planned", () => {
  const x = sample();
  x.f = [];
  x.m.final_verifications = {};
  assert.ok(errors(x).length);
  x.l[0].status = "planned";
  assert.ok(errors(x).length);
});
test("incomplete may retain unvalidated candidates only in ledger with reason", () => {
  const x = sample();
  x.m.run_status = "incomplete";
  x.f = [];
  x.m.final_verifications = {};
  x.l[0].final_dispositions = {};
  assert.ok(errors(x).length);
  x.m.incomplete_reason = "validation_budget_exhausted";
  assert.deepEqual(errors(x), []);
});
test("standard rejects same reviewer and hunter verification", () => {
  const x = sample();
  x.m.final_verifications.finding.phase5_agent_id = "verifier-1";
  assert.ok(errors(x).length);
  x.m.final_verifications.finding.phase3_agent_id = "hunter";
  assert.ok(errors(x).length);
});
test("quick shares a fresh verifier across both phases", () => {
  const x = sample();
  x.m.profile = "quick";
  x.m.final_verifications.finding.phase5_agent_id = "verifier-1";
  assert.deepEqual(errors(x), []);
});
test("carried-owner exception requires compatible prior state", () => {
  const x = sample();
  x.l[0].agent_id = "verifier-1";
  x.l[0].carried_verification_owner = true;
  assert.ok(errors(x).length);
  x.l[0].prior_status = "prior_confirmed_same_source";
  assert.deepEqual(errors(x), []);
});
test("rejected records require Phase 3 but no Phase 5", () => {
  const x = sample();
  x.f[0].verdict = "rejected";
  x.l[0].final_dispositions.finding = "rejected";
  x.m.final_verifications.finding.verdict = "rejected";
  x.m.final_verifications.finding.phase5_agent_id = null;
  assert.deepEqual(errors(x), []);
});
test("orphan verifications and dispositions fail", () => {
  const x = sample();
  x.m.final_verifications.extra = {};
  x.l[0].final_dispositions.extra = "confirmed";
  assert.ok(errors(x).length);
});
test("CLI validates complete zero-findings run and rejects unsafe/malformed inputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "security-run-"));
  try {
    const files = ["metadata.json", "ledger.json", "findings.json"].map((n) => path.join(dir, n));
    fs.writeFileSync(
      files[0],
      JSON.stringify({ profile: "standard", run_status: "complete", final_verifications: {} }),
    );
    fs.writeFileSync(files[1], "[]");
    fs.writeFileSync(files[2], "[]");
    const run = () =>
      spawnSync(process.execPath, [path.join(__dirname, "validate-run.cjs"), ...files], {
        encoding: "utf8",
        timeout: 5000,
      });
    assert.equal(run().status, 0);
    fs.writeFileSync(files[0], '{"profile":"standard","profile":"quick"}');
    assert.equal(run().status, 1);
    fs.unlinkSync(files[0]);
    fs.symlinkSync(files[1], files[0]);
    assert.equal(run().status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
