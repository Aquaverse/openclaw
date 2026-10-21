#!/usr/bin/env node
// Cross-file bookkeeping validation; does not prove source claims or execution safety.
const ledgerValidator = require("./validate-coverage-ledger.cjs");
const findingsValidator = require("./validate-findings.cjs");
const schema = require("./report-schema.json");
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function validateLinks(metadata, ledger, findings) {
  const errors = [];
  const add = (s) => {
    if (errors.length < 100) errors.push(s);
  };
  if (
    !object(metadata) ||
    !["complete", "incomplete", "in_progress"].includes(metadata.run_status) ||
    !["quick", "standard", "deep"].includes(metadata.profile)
  )
    return ["Invalid metadata run_status or profile"];
  if (
    metadata.run_status === "incomplete" &&
    (typeof metadata.incomplete_reason !== "string" || !metadata.incomplete_reason.trim())
  )
    add("Incomplete run requires incomplete_reason");
  const verifications = metadata.final_verifications;
  if (!object(verifications)) return [...errors, "metadata.final_verifications must be an object"];
  const records = new Map(findings.map((f) => [f.fingerprint, f]));
  if (records.size !== findings.length) add("Duplicate finding fingerprint");
  const links = new Map();
  for (const unit of ledger) {
    const dispositions = unit.final_dispositions || {};
    if (!object(dispositions)) {
      add("Invalid ledger final_dispositions");
      continue;
    }
    if (metadata.run_status === "complete" && ["planned", "in_progress"].includes(unit.status))
      add("Complete run has unfinished unit");
    for (const fp of unit.result_fingerprints) {
      if (!links.has(fp)) links.set(fp, []);
      links.get(fp).push(unit);
      const record = records.get(fp);
      if (!record) {
        if (metadata.run_status === "complete" || own(dispositions, fp))
          add("Ledger disposition or complete candidate has no finding");
      } else if (dispositions[fp] !== record.verdict) add("Ledger verdict differs from finding");
    }
    for (const fp of Object.keys(dispositions))
      if (!unit.result_fingerprints.includes(fp))
        add("Disposition lacks current ledger fingerprint");
  }
  for (const [fp, record] of records) {
    const units = links.get(fp);
    if (!units) {
      add("Finding lacks current ledger link");
      continue;
    }
    const v = own(verifications, fp) ? verifications[fp] : null;
    if (
      !object(v) ||
      v.verdict !== record.verdict ||
      !ledgerValidator.isSafeAgentId(v.phase3_agent_id)
    ) {
      add("Missing or mismatched final verification");
      continue;
    }
    if (record.verdict === "rejected") {
      if (v.phase5_agent_id !== null)
        add("Rejected record uses Phase 3 only; phase5_agent_id must be null");
    } else {
      if (!ledgerValidator.isSafeAgentId(v.phase5_agent_id)) add("Missing Phase 5 reviewer");
      if (
        metadata.profile === "quick"
          ? v.phase3_agent_id !== v.phase5_agent_id
          : v.phase3_agent_id === v.phase5_agent_id
      )
        add("Reviewer separation does not match profile");
    }
    for (const unit of units) {
      const carried =
        unit.carried_verification_owner === true &&
        ["prior_confirmed_same_source", "prior_needs_validation"].includes(unit.prior_status);
      if (unit.carried_verification_owner === true && !carried)
        add("Invalid carried owner exception");
      if (v.phase3_agent_id === unit.agent_id && !carried)
        add("Phase 3 reviewer is assignment owner");
      if (
        record.verdict !== "rejected" &&
        v.phase5_agent_id === unit.agent_id &&
        !(carried && metadata.profile === "quick")
      )
        add("Phase 5 reviewer is assignment owner");
    }
  }
  for (const fp of Object.keys(verifications))
    if (!records.has(fp)) add("Verification lacks finding");
  return errors;
}
function readDocument(file) {
  const text = ledgerValidator.readFileWithinLimit(file);
  ledgerValidator.preflightJsonText(text);
  return JSON.parse(text);
}
function run(args) {
  if (args.length !== 3) {
    console.error("Usage: node validate-run.cjs <metadata.json> <ledger.json> <findings.json>");
    return 2;
  }
  try {
    const [metadata, ledger, findings] = args.map(readDocument);
    const structure = [
      ...ledgerValidator.validateDocument(ledger),
      ...findingsValidator.validateDocument(findings, schema),
    ];
    // Keep diagnostics fixed: never echo untrusted paths, keys or JSON values.
    if (structure.length) {
      console.error("FAIL: per-file validation failed; run the individual validators");
      return 1;
    }
    const errors = validateLinks(metadata, ledger, findings);
    for (const error of errors) console.error("ERROR: " + error);
    if (errors.length) return 1;
    console.log("PASS: recorded run links and dispositions are consistent");
    return 0;
  } catch {
    console.error("FAIL: input could not be read or parsed safely");
    return 1;
  }
}
module.exports = { validateLinks, readDocument, run };
if (require.main === module) process.exit(run(process.argv.slice(2)));
