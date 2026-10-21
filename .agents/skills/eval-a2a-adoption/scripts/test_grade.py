import copy
import unittest

from grade import full_weeks, grade, latest_samples

AS_OF = "2026-10-13T08:00:00Z"


def assessment():
    return {"schema_version": 4, "repository": "owner/repo", "evaluated_at": AS_OF,
            "timezone": "Asia/Shanghai",
            "file_integrity": {"result": "pass", "complete": True, "files": [
                {"path": "a2a_dev_process.md", "status": "pass",
                 "chain": ["a2a_dev_process.md"], "evidence": ["recursive-audit"]}]},
            "collection": {"issue_selection_complete": True, "pr_selection_complete": True,
                           "excellence_complete": True, "metrics_complete": True},
            "excellence": {"result": "pass", "reason": "Applicable process checks pass",
                           "evidence": ["process-checks"]},
            "samples": {"issues": [{"number": n, "created_at": "2026-10-12T00:00:00Z",
                                     "result": "pass", "evidence": ["format-checks"]}
                                    for n in range(50, 0, -1)],
                        "prs": [{"number": n, "created_at": "2026-10-12T00:00:00Z",
                                 "result": "pass", "evidence": ["pr-checks"]}
                                for n in range(80, 70, -1)]},
            "deliveries": [], "limitations": []}


def add_week(data, week, features, bugs, estimate="3"):
    start, _ = full_weeks(AS_OF)[week]
    base = len(data["deliveries"]) + 100
    for i in range(features + bugs):
        data["deliveries"].append({"number": base + i, "type": "Feature" if i < features else "Bug",
                                   "eligible": True, "accepted_closed_at": start.isoformat(),
                                   "estimate": estimate, "estimate_confirmed": True,
                                   "evidence": ["acceptance", "closure", "owner-confirmation"]})


def volume(data, excellent=False):
    for week in range(4):
        add_week(data, week, 50 if excellent else 25, 100 if excellent else 50,
                 "5" if excellent else "3")


class GradeTests(unittest.TestCase):
    def test_format_threshold_40_pass_and_39_fail(self):
        data = assessment()
        for row in data["samples"]["issues"][:10]:
            row["result"] = "fail"
        self.assertEqual(grade(data)["rating"], "合格")
        data["samples"]["issues"][10]["result"] = "fail"
        self.assertEqual(grade(data)["rating"], "不合格")

    def test_unknown_formats_use_confirmed_bounds(self):
        data = assessment()
        for row in data["samples"]["issues"][:10]:
            row["result"] = "unknown"
        self.assertEqual(grade(data)["rating"], "合格")
        data["samples"]["issues"][10]["result"] = "unknown"
        self.assertIsNone(grade(data)["rating"])
        for row in data["samples"]["issues"][:11]:
            row["result"] = "fail"
        data["samples"]["issues"][11]["result"] = "unknown"
        self.assertEqual(grade(data)["rating"], "不合格")

    def test_confirmed_repository_total_below_50_is_not_qualified(self):
        for size in [0, 1, 39, 40, 49]:
            data = assessment()
            data["samples"]["issues"] = data["samples"]["issues"][:size]
            data["collection"]["metrics_complete"] = False
            result = grade(data)
            self.assertEqual(result["rating"], "不合格")
            self.assertEqual(result["status"], "complete")

    def test_39_pass_10_fail_one_unknown_is_undecided(self):
        data = assessment()
        for row in data["samples"]["issues"][:10]:
            row["result"] = "fail"
        data["samples"]["issues"][10]["result"] = "unknown"
        self.assertIsNone(grade(data)["rating"])
        data["samples"]["issues"][10]["result"] = "pass"
        result = grade(data)
        self.assertEqual(result["rating"], "合格")
        self.assertEqual(result["issue_format"]["required_sample"], 50)
        self.assertEqual(result["issue_format"]["required_passes"], 40)

    def test_partial_pagination_is_not_evidence_of_a_small_repository(self):
        for size in [0, 20, 49, 50]:
            data = assessment()
            data["samples"]["issues"] = data["samples"]["issues"][:size]
            data["collection"]["issue_selection_complete"] = False
            self.assertIsNone(grade(data)["rating"])
        data = assessment()
        for row in data["samples"]["issues"]:
            row["result"] = "fail"
        data["collection"]["issue_selection_complete"] = False
        self.assertIsNone(grade(data)["rating"])

    def test_no_ci_or_prs_required_for_qualified(self):
        data = assessment()
        data["samples"]["prs"] = []
        data["excellence"]["result"] = "unknown"
        data["collection"].update(pr_selection_complete=False, excellence_complete=False,
                                 metrics_complete=False)
        result = grade(data)
        self.assertEqual(result["rating"], "合格")
        self.assertEqual(result["status"], "incomplete")

    def test_ci_failure_only_blocks_excellent(self):
        data = assessment()
        data["samples"]["prs"][0]["result"] = "fail"
        data["excellence"]["result"] = "fail"
        self.assertEqual(grade(data)["rating"], "合格")
        volume(data, excellent=True)
        self.assertEqual(grade(data)["rating"], "良好")
        data["excellence"]["result"] = "pass"
        data["samples"]["prs"][0]["result"] = "pass"
        self.assertEqual(grade(data)["rating"], "优秀")

    def test_file_audit_only_blocks_excellent(self):
        data = assessment()
        data["file_integrity"].update(result="fail", files=[
            {"path": "a2a_dev_process.md", "status": "missing",
             "chain": ["a2a_dev_process.md"], "evidence": ["confirmed-tree-absence"]}])
        self.assertEqual(grade(data)["rating"], "合格")
        volume(data, excellent=True)
        self.assertEqual(grade(data)["rating"], "良好")
        data["file_integrity"].update(result="unknown", complete=False, files=[
            {"path": "a2a_dev_process.md", "status": "unknown",
             "chain": ["a2a_dev_process.md"], "reason": "unreadable", "evidence": []}])
        result = grade(data)
        self.assertEqual(result["rating"], "良好")
        self.assertEqual(result["status"], "incomplete")

    def test_unknown_excellence_does_not_erase_good_grade(self):
        data = assessment()
        volume(data, excellent=True)
        data["excellence"]["result"] = "unknown"
        data["collection"]["excellence_complete"] = False
        result = grade(data)
        self.assertEqual(result["rating"], "良好")
        self.assertEqual(result["status"], "incomplete")
        data["collection"]["pr_selection_complete"] = False
        data["excellence"]["result"] = "fail"
        self.assertEqual(grade(data)["excellent_gate"], "unknown")

    def test_excellent_requires_ten_verified_prs(self):
        for key in ["pr_selection_complete", "excellence_complete"]:
            data = assessment()
            data["collection"][key] = False
            with self.assertRaisesRegex(ValueError, "10 fully checked"):
                grade(data)
        data = assessment()
        data["samples"]["prs"].pop()
        with self.assertRaisesRegex(ValueError, "10 fully checked"):
            grade(data)

    def test_format_failure_overrides_volume_not_ci(self):
        data = assessment()
        volume(data, excellent=True)
        for row in data["samples"]["issues"][:11]:
            row["result"] = "fail"
        self.assertEqual(grade(data)["rating"], "不合格")

    def test_good_thresholds_and_point_boundary(self):
        data = assessment()
        for week in range(4):
            add_week(data, week, 25, 50, "2")
            for row in data["deliveries"][-75:-25]:
                row["estimate"] = "3"
        self.assertEqual(grade(data)["rating"], "良好")
        changed = copy.deepcopy(data)
        changed["deliveries"][0]["estimate"] = "2"
        self.assertEqual(grade(changed)["rating"], "合格")
        for kind in ["Feature", "Bug"]:
            changed = copy.deepcopy(data)
            changed["deliveries"].remove(next(r for r in changed["deliveries"] if r["type"] == kind))
            self.assertEqual(grade(changed)["rating"], "合格")

    def test_excellent_exact_points_and_all_weeks_and(self):
        data = assessment()
        for week in range(4):
            add_week(data, week, 50, 100, "3")
            for row in data["deliveries"][-150:-125]:
                row["estimate"] = "5"
        self.assertEqual(grade(data)["rating"], "优秀")
        data["deliveries"][0]["estimate"] = "3"
        self.assertEqual(grade(data)["rating"], "良好")
        data = assessment()
        for week in [1, 2, 3]:
            add_week(data, week, 100, 200, "8")
        self.assertEqual(grade(data)["rating"], "合格")

    def test_tbd_is_zero_even_without_owner_point_confirmation(self):
        for confirmed in [True, False]:
            data = assessment()
            add_week(data, 0, 1, 1, "TBD")
            for row in data["deliveries"]:
                row["estimate_confirmed"] = confirmed
            result = grade(data)
            self.assertTrue(result["metrics_complete"])
            self.assertEqual(result["weeks"][0]["estimate"], 0)
            self.assertEqual(result["weeks"][0]["feature"], 1)
            self.assertEqual(result["weeks"][0]["bug"], 1)
            self.assertEqual(result["weeks"][0]["unknown_estimates"], [])
            self.assertEqual(result["weeks"][0]["tbd_zero_estimates"], [100, 101])

    def test_tbd_does_not_fabricate_points_or_delivery_acceptance(self):
        data = assessment()
        volume(data)
        data["deliveries"][0]["estimate"] = "TBD"
        self.assertEqual(grade(data)["weeks"][0]["estimate"], 222)
        data["deliveries"] = [{"number": 100, "eligible": None, "reason": "acceptance unknown",
                               "estimate": "TBD", "evidence": []}]
        self.assertFalse(grade(data)["metrics_complete"])

    def test_other_unknown_estimates_remain_unknown(self):
        for estimate, confirmed in [(None, False), ("13", True), ("3", False), (3, True), ("0", True)]:
            data = assessment()
            add_week(data, 0, 1, 0)
            data["deliveries"][0].update(estimate=estimate, estimate_confirmed=confirmed)
            result = grade(data)
            self.assertEqual(result["rating"], "合格")
            self.assertFalse(result["metrics_complete"])
            self.assertEqual(result["weeks"][0]["unknown_estimates"], [100])

    def test_week_edges_duplicates_and_conflicts(self):
        data = assessment()
        add_week(data, 0, 1, 0)
        record = data["deliveries"][0]
        data["deliveries"].append(copy.deepcopy(record))
        self.assertEqual(grade(data)["weeks"][0]["feature"], 1)
        data["deliveries"][1]["estimate"] = "5"
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            grade(data)
        data["deliveries"] = [record]
        record["accepted_closed_at"] = "2026-09-20T16:00:00Z"
        self.assertEqual(grade(data)["weeks"][1]["feature"], 1)
        record["accepted_closed_at"] = "2026-10-11T16:00:00Z"
        self.assertEqual(grade(data)["outside_window"], [100])

    def test_excluded_deliveries_do_not_count(self):
        data = assessment()
        data["deliveries"] = [{"number": 100, "eligible": False, "reason": "duplicate/not planned",
                               "evidence": ["closure-reason"]}]
        self.assertEqual(grade(data)["excluded"], [100])
        self.assertEqual(grade(data)["weeks"][0]["bug"], 0)

    def test_latest_samples_default_limits_freeze_and_ties(self):
        records = [{"number": n, "created_at": "2026-10-12T00:00:00Z"} for n in range(65)]
        records += [{"number": 99, "created_at": "2026-10-13T01:00:00Z", "pull_request": {}},
                    {"number": 100, "created_at": "2026-10-14T00:00:00Z"}]
        self.assertEqual([r["number"] for r in latest_samples(records, "issues", AS_OF)],
                         list(range(64, 14, -1)))
        self.assertEqual(len(latest_samples(records, "prs", AS_OF)), 10)
        self.assertEqual(latest_samples(records, "prs", AS_OF)[0]["number"], 99)

    def test_local_monday_and_no_partial_week(self):
        bounds = full_weeks(AS_OF)
        self.assertEqual(bounds[0][0].isoformat(), "2026-09-14T00:00:00+08:00")
        self.assertEqual(bounds[-1][1].isoformat(), "2026-10-12T00:00:00+08:00")
        self.assertNotEqual(full_weeks("2026-10-11T15:59:59Z"), bounds)

    def test_old_inputs_cannot_silently_reuse_old_semantics(self):
        for version in [2, 3]:
            data = assessment()
            data["schema_version"] = version
            with self.assertRaisesRegex(ValueError, "schema_version"):
                grade(data)

    def test_invalid_evidence_order_and_identity_rejected(self):
        for mutate in [lambda d: d["samples"]["issues"][0].update(evidence=[]),
                       lambda d: d["samples"]["issues"].reverse(),
                       lambda d: d["samples"]["issues"][0].update(created_at="2026-10-14T00:00:00Z"),
                       lambda d: d["samples"]["issues"][0].update(number=1),
                       lambda d: d["file_integrity"].update(result="fail"),
                       lambda d: d.update(evaluated_at="2026-10-13T08:00:00")]:
            data = assessment()
            mutate(data)
            with self.assertRaises(ValueError):
                grade(data)
        data = assessment()
        data["samples"]["prs"][0]["result"] = "fail"
        with self.assertRaisesRegex(ValueError, "Excellence pass|contradicts"):
            grade(data)


if __name__ == "__main__":
    unittest.main()
