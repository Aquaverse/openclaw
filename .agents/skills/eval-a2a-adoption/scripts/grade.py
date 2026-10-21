#!/usr/bin/env python3
"""Compute adoption ratings from evidence-backed assessments; no network calls."""

import argparse
import json
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import PurePosixPath
from zoneinfo import ZoneInfo


SIZES = {"1", "2", "3", "5", "8"}
ISSUE_SAMPLE_SIZE = 50
ISSUE_REQUIRED_PASSES = 40
THRESHOLDS = {
    "good": {"feature": 25, "bug": 50, "estimate": 200},
    "excellent": {"feature": 50, "bug": 100, "estimate": 500},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def timestamp(value):
    require(isinstance(value, str), "Timestamp must be an ISO string")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None and result.utcoffset() is not None,
            "Timestamp must have a UTC offset")
    return result


def full_weeks(evaluated_at, tz_name="Asia/Shanghai"):
    local = timestamp(evaluated_at).astimezone(ZoneInfo(tz_name))
    monday = local.date() - timedelta(days=local.weekday())
    end = datetime.combine(monday, time.min, tzinfo=local.tzinfo)
    return [(end - timedelta(weeks=n), end - timedelta(weeks=n - 1))
            for n in range(4, 0, -1)]


def latest_samples(records, kind, evaluated_at, limit=None):
    """Select from a fully acquired candidate list, not proof of pagination."""
    require(kind in {"issues", "prs"}, "Unknown sample kind")
    limit = (ISSUE_SAMPLE_SIZE if kind == "issues" else 10) if limit is None else limit
    cutoff = timestamp(evaluated_at)
    selected = [record for record in records
                if (kind != "issues" or "pull_request" not in record)
                and timestamp(record["created_at"]) <= cutoff]
    return sorted(selected, key=lambda r: (timestamp(r["created_at"]), r["number"]),
                  reverse=True)[:limit]


def evidence(record, label):
    values = record.get("evidence")
    require(isinstance(values, list) and all(isinstance(v, str) and v.strip() for v in values),
            f"{label}: evidence must be a list of nonempty strings")
    return values


def number(record, label):
    value = record.get("number")
    require(type(value) is int and value > 0, f"{label}: positive Issue/PR number required")
    return value


def file_integrity(record):
    """Validate an Agent's recursive inventory; do not infer filesystem absence."""
    require(isinstance(record, dict), "file_integrity assessment required")
    require(type(record.get("complete")) is bool, "file_integrity.complete must be boolean")
    files = record.get("files")
    require(isinstance(files, list) and files, "File inventory must include the process root")
    root = "a2a_dev_process.md"
    seen, states = set(), []
    for entry in files:
        require(isinstance(entry, dict), "File inventory entry must be an object")
        path = entry.get("path")
        require(isinstance(path, str) and path and not path.startswith("/")
                and ".." not in PurePosixPath(path).parts
                and str(PurePosixPath(path)) == path,
                "File path must be normalized and repository-relative")
        require(path not in seen, "Duplicate inventory path; retain references in evidence")
        seen.add(path)
        chain = entry.get("chain")
        require(isinstance(chain, list) and chain and chain[0] == root and chain[-1] == path
                and all(isinstance(p, str) and p.strip() for p in chain),
                "File reference chain must start at process root and end at target")
        state = entry.get("status")
        require(state in {"pass", "missing", "unknown", "na"}, "Invalid file status")
        require(path != root or state != "na", "Process root cannot be excluded")
        sources = evidence(entry, "file")
        if state in {"pass", "missing", "na"}:
            require(sources, "Known file status requires reference/verification evidence")
        if state in {"unknown", "na"}:
            require(isinstance(entry.get("reason"), str) and entry["reason"].strip(),
                    "Unknown/excluded file requires reason")
        states.append(state)
    require(root in seen, "File inventory must include a2a_dev_process.md")
    expected = ("fail" if "missing" in states else
                "unknown" if "unknown" in states or not record["complete"] else "pass")
    require(record.get("result") == expected, "File integrity result contradicts inventory")
    return record


def sample_records(records, kind, as_of):
    limit = ISSUE_SAMPLE_SIZE if kind == "issues" else 10
    require(isinstance(records, list) and len(records) <= limit,
            f"samples.{kind} must contain at most {limit} records")
    keys, seen = [], set()
    for record in records:
        identifier = number(record, kind)
        require(identifier not in seen, "Duplicate sample number")
        seen.add(identifier)
        created = timestamp(record["created_at"])
        require(created <= as_of, "Sample created after frozen evaluation time")
        keys.append((created, identifier))
        require(record.get("result") in {"pass", "fail", "unknown"}, "Invalid sample result")
        sources = evidence(record, kind)
        if record["result"] != "unknown":
            require(sources, "Known sample result requires evidence")
    require(keys == sorted(keys, reverse=True), "Samples must be newest-created first")
    return records


def grade(data):
    require(isinstance(data, dict), "Assessment must be an object")
    require(type(data.get("schema_version")) is int and data["schema_version"] == 4,
            "Unsupported schema_version; reassess v2/v3 evidence under v4 rules")
    repo = data.get("repository")
    require(isinstance(repo, str) and repo.count("/") == 1 and all(repo.split("/")),
            "repository must be OWNER/REPO")
    as_of = timestamp(data["evaluated_at"])
    tz_name = data.get("timezone", "Asia/Shanghai")
    bounds = full_weeks(data["evaluated_at"], tz_name)
    integrity = file_integrity(data.get("file_integrity"))
    collection = data.get("collection", {})
    for key in ("issue_selection_complete", "pr_selection_complete", "excellence_complete", "metrics_complete"):
        require(type(collection.get(key)) is bool, f"collection.{key} must be boolean")
    samples = data.get("samples", {})
    issues = sample_records(samples.get("issues"), "issues", as_of)
    prs = sample_records(samples.get("prs"), "prs", as_of)
    require(not ({r["number"] for r in issues} & {r["number"] for r in prs}),
            "Issue and PR samples must not overlap")
    passed = sum(r["result"] == "pass" for r in issues)
    failed = sum(r["result"] == "fail" for r in issues)
    unknown = sum(r["result"] == "unknown" for r in issues)
    # Complete selection with fewer than 50 records proves the repository is too small.
    # Partial pagination must keep selection_complete false, not imply a small repository.
    format_result = ("unknown" if not collection["issue_selection_complete"] else
                     "fail" if len(issues) < ISSUE_SAMPLE_SIZE else
                     "pass" if passed >= ISSUE_REQUIRED_PASSES else
                     "fail" if failed > ISSUE_SAMPLE_SIZE - ISSUE_REQUIRED_PASSES else "unknown")
    excellence = data.get("excellence", {})
    state = excellence.get("result")
    require(state in {"pass", "fail", "unknown"}, "Invalid excellence result")
    sources = evidence(excellence, "excellence")
    require(isinstance(excellence.get("reason"), str) and excellence["reason"].strip(),
            "excellence.reason required")
    if state != "unknown":
        require(sources, "Known excellence result requires evidence")
    if state == "pass":
        require(collection["pr_selection_complete"] and collection["excellence_complete"]
                and len(prs) == 10 and all(r["result"] == "pass" for r in prs),
                "Excellence pass requires 10 fully checked latest PRs")
    if any(r["result"] == "fail" for r in prs) and collection["pr_selection_complete"]:
        require(state == "fail", "Confirmed PR failure contradicts excellence result")
    excellent_gate = ("fail" if integrity["result"] == "fail" or
                      (state == "fail" and collection["pr_selection_complete"]) else
                      "pass" if integrity["result"] == "pass" and state == "pass" else "unknown")
    limitations = data.get("limitations", [])
    require(isinstance(limitations, list) and all(isinstance(v, str) for v in limitations),
            "limitations must be strings")
    limitations = list(limitations)
    if len(issues) < ISSUE_SAMPLE_SIZE:
        limitations.append("Confirmed fewer than 50 repository Issues: not qualified."
                           if collection["issue_selection_complete"] else
                           "Fewer than 50 visible Issues; repository total remains unconfirmed.")
    if unknown:
        limitations.append("Some Issue formats remain unknown; only confirmed passes count toward 40.")
    weeks = [{"start": start.isoformat(), "end": end.isoformat(),
              "start_utc": start.astimezone(timezone.utc).isoformat(),
              "end_utc": end.astimezone(timezone.utc).isoformat(),
              "feature": 0, "bug": 0, "estimate": 0,
              "unknown_estimates": [], "tbd_zero_estimates": [], "included": []}
             for start, end in bounds]
    metrics_complete = collection["metrics_complete"]
    deliveries = data.get("deliveries")
    require(isinstance(deliveries, list), "deliveries must be a list")
    seen, excluded, outside, unknown_eligibility = {}, [], [], []
    for record in deliveries:
        identifier = number(record, "delivery")
        if identifier in seen:
            require(seen[identifier] == record, "Conflicting duplicate delivery record")
            continue
        seen[identifier] = record
        eligibility = record.get("eligible")
        require(eligibility is None or type(eligibility) is bool, "eligible must be bool or null")
        sources = evidence(record, "delivery")
        if eligibility is not True:
            require(isinstance(record.get("reason"), str) and record["reason"].strip(),
                    "Excluded/unknown delivery requires reason")
            if eligibility is None:
                metrics_complete = False
                unknown_eligibility.append(identifier)
            else:
                require(sources, "Exclusion requires evidence")
                excluded.append(identifier)
            continue
        require(record.get("type") in {"Feature", "Bug"}, "Only Feature/Bug can be eligible")
        require(sources, "Eligible delivery requires acceptance/closure evidence")
        closed = timestamp(record["accepted_closed_at"])
        require(closed <= as_of, "Delivery closure is after evaluation time")
        require(type(record.get("estimate_confirmed")) is bool, "estimate_confirmed must be bool")
        index = next((i for i, (start, end) in enumerate(bounds) if start <= closed < end), None)
        if index is None:
            outside.append(identifier)
            continue
        week = weeks[index]
        week["feature" if record["type"] == "Feature" else "bug"] += 1
        week["included"].append(identifier)
        estimate = record.get("estimate")
        if estimate == "TBD":
            week["tbd_zero_estimates"].append(identifier)
        elif isinstance(estimate, str) and estimate in SIZES and record["estimate_confirmed"]:
            week["estimate"] += int(estimate)
        else:
            week["unknown_estimates"].append(identifier)
            metrics_complete = False
    if not metrics_complete:
        limitations.append("Weekly metrics incomplete; only literal TBD counts as zero, other unknowns do not.")
    for week in weeks:
        for level, thresholds in THRESHOLDS.items():
            gap = {key: max(0, minimum - week[key]) for key, minimum in thresholds.items()}
            week[level] = {"gap": gap,
                           "met": all(value == 0 for value in gap.values()) if metrics_complete else None}
    good_volume = metrics_complete and all(w["good"]["met"] for w in weeks)
    excellent_volume = metrics_complete and all(w["excellent"]["met"] for w in weeks)
    if format_result == "fail":
        rating, complete = "不合格", True
    elif format_result == "unknown":
        rating, complete = None, False
    elif excellent_volume and excellent_gate == "pass":
        rating, complete = "优秀", True
    elif good_volume:
        rating = "良好"
        complete = not excellent_volume or excellent_gate == "fail"
    else:
        rating, complete = "合格", metrics_complete
    return {"schema_version": 4, "repository": repo,
            "evaluated_at": data["evaluated_at"], "timezone": tz_name,
            "status": "complete" if complete else "incomplete", "rating": rating,
            "rating_basis": "issue_format" if rating in {None, "不合格", "合格"} else "weekly_volume",
            "file_integrity": integrity,
            "issue_format": {"result": format_result, "required_sample": ISSUE_SAMPLE_SIZE,
                             "required_passes": ISSUE_REQUIRED_PASSES,
                             "pass": passed, "fail": failed, "unknown": unknown},
            "excellent_gate": excellent_gate,
            "sample_counts": {"issues": len(issues), "prs": len(prs)}, "weeks": weeks,
            "metrics_complete": metrics_complete, "excluded": excluded,
            "outside_window": outside, "unknown_eligibility": unknown_eligibility,
            "limitations": limitations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assessment", help="Evidence-backed assessment JSON path")
    args = parser.parse_args()
    try:
        with open(args.assessment, encoding="utf-8") as source:
            result = grade(json.load(source))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"Invalid assessment: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
