"""Rule tests for the pure section of contracts/lockstep.py."""

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "contracts" / "lockstep.py").read_text(encoding="utf-8")
START = SOURCE.index("# RULES_START\n") + len("# RULES_START\n")
END = SOURCE.index("# RULES_END")
NS = {}
exec(SOURCE[START:END], NS)

parse_manifest = NS["parse_manifest"]
canonical_spec = NS["canonical_spec"]
fresh_gate = NS["fresh_gate"]
extract_fact = NS["extract_fact"]
extract_npm = NS["extract_npm"]
facts_equivalent = NS["facts_equivalent"]
fact_acceptable = NS["fact_acceptable"]
apply_fact = NS["apply_fact"]
apply_attest = NS["apply_attest"]
advance_allowed = NS["advance_allowed"]
attest_allowed = NS["attest_allowed"]
settle_allowed = NS["settle_allowed"]
refund_allowed = NS["refund_allowed"]
flags_after_consent = NS["flags_after_consent"]
unwind_ready = NS["unwind_ready"]
parse_deadline = NS["parse_deadline"]
clip_text = NS["clip_text"]
reason_fits = NS["reason_fits"]
source_url = NS["source_url"]
BODY_CAP = NS["BODY_CAP"]
VERSION = NS["VERSION"]

SIGNER = "0x" + ("11" * 20)
OTHER = "0x" + ("22" * 20)
RELEASE = "fact npm left-pad 1.3.0\nattest " + SIGNER + "\n"
NPM_URL = "https://registry.npmjs.org/left-pad/1.3.0"
PYPI_URL = "https://pypi.org/pypi/six/1.16.0/json"
GH_URL = "https://api.github.com/repos/pallets/flask/releases/tags/3.0.0"


def gates_of(spec):
    return [fresh_gate(gate) for gate in parse_manifest(spec)]


class ManifestTests(unittest.TestCase):
    def test_version(self):
        self.assertEqual(VERSION, "1.0.0-lockstep")

    def test_release_manifest_is_canonical(self):
        gates = parse_manifest("  Fact   npm   left-pad   1.3.0  \r\n# note\n\nattest " + SIGNER.upper() + "\n")
        self.assertEqual(canonical_spec(gates), "fact npm left-pad 1.3.0\nattest " + SIGNER)
        self.assertEqual(gates[0]["source"], NPM_URL)
        self.assertEqual(gates[1]["signer"], SIGNER)

    def test_registry_urls_are_contract_built(self):
        gates = parse_manifest(
            "fact npm @scope/pkg 1.2.3\nfact pypi Six 1.16.0\nfact github pallets/flask 3.0.0\n"
        )
        self.assertEqual(gates[0]["source"], "https://registry.npmjs.org/@scope/pkg/1.2.3")
        self.assertEqual(gates[1]["pkg"], "six")
        self.assertEqual(gates[1]["source"], PYPI_URL)
        self.assertEqual(gates[2]["source"], GH_URL)
        for gate in gates:
            self.assertTrue(gate["source"].startswith("https://"))
            self.assertNotIn("?", gate["source"])

    def test_rejects_thin_or_hostile_specs(self):
        samples = {
            "fact npm left-pad 1.3.0\n": "too_few_gates",
            "attest " + SIGNER + "\nattest " + OTHER + "\n": "need_fact_gate",
            "fact npm ../left-pad 1.3.0\nfact npm left-pad 1.3.0\n": "bad_npm_package",
            "fact npm Left-Pad 1.3.0\nfact npm left-pad 1.3.0\n": "bad_npm_package",
            "fact http example.com 1.0.0\nfact npm left-pad 1.3.0\n": "bad_authority",
            "fact npm left-pad 1.3.0 extra\nfact npm left-pad 1.3.0\n": "bad_line",
            "fact github pallets/flask/extra 3.0.0\nfact npm left-pad 1.3.0\n": "bad_github_repo",
            "fact npm left-pad 1..3\nfact npm left-pad 1.3.0\n": "bad_version",
            "attest 0x0000000000000000000000000000000000000000\nfact npm left-pad 1.3.0\n": "bad_address",
            "fact npm left-pad 1.3.0\nattest 0x123\n": "bad_address",
            "open https://example.com\nfact npm left-pad 1.3.0\n": "bad_line",
        }
        for spec, code in samples.items():
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError) as raised:
                    parse_manifest(spec)
                self.assertEqual(str(raised.exception), code)

    def test_gate_bounds_and_deadline(self):
        body = "\n".join(["fact npm left-pad 1.3.0"] * 5)
        self.assertEqual(len(parse_manifest(body)), 5)
        with self.assertRaises(ValueError) as raised:
            parse_manifest(body + "\nfact npm left-pad 1.3.0\n")
        self.assertEqual(str(raised.exception), "too_many_gates")
        self.assertEqual(parse_deadline("120"), 120)
        self.assertEqual(parse_deadline("2592000"), 2592000)
        with self.assertRaises(ValueError):
            parse_deadline("119")
        with self.assertRaises(ValueError):
            parse_deadline("2592001")
        self.assertEqual(clip_text("  Ship   it ", 60, "bad_title", True, 2), "Ship it")

    def test_no_user_host_can_be_parsed_as_a_source(self):
        with self.assertRaises(ValueError):
            source_url("https", "example.com", "1")


class ExtractTests(unittest.TestCase):
    def test_npm_match_and_misses(self):
        match = extract_fact("npm", {"name": "left-pad", "version": "1.3.0", "readme": "ignore"}, 200, "left-pad", "1.3.0")
        self.assertEqual(match["outcome"], "match")
        self.assertEqual(match["reason"], "name_version_match")
        self.assertEqual(match["source"], NPM_URL)
        absent = extract_fact("npm", {"error": "Not found"}, 404, "left-pad", "9.9.9")
        self.assertEqual(absent["outcome"], "absent")
        mismatch = extract_fact("npm", {"name": "left-pad", "version": "1.2.0"}, 200, "left-pad", "1.3.0")
        self.assertEqual(mismatch["reason"], "version_mismatch")
        page = extract_fact("npm", "<html>just a moment</html>", 200, "left-pad", "1.3.0")
        self.assertEqual(page["reason"], "not_json")
        huge = "{" + ("x" * (BODY_CAP + 1))
        self.assertEqual(extract_npm(huge, 200, "left-pad", "1.3.0", NPM_URL)["reason"], "body_too_large")

    def test_pypi_yank_and_github_draft(self):
        live = extract_fact("pypi", {"info": {"name": "Six", "version": "1.16.0"}}, 200, "six", "1.16.0")
        self.assertEqual(live["outcome"], "match")
        self.assertEqual(live["observed_name"], "Six")
        yanked = extract_fact("pypi", {"info": {"name": "six", "version": "1.16.0", "yanked": True}}, 200, "six", "1.16.0")
        self.assertEqual(yanked["reason"], "yanked")
        self.assertEqual(extract_fact("pypi", {"message": "Not Found"}, 404, "six", "9.9.9")["outcome"], "absent")
        published = extract_fact("github", {"tag_name": "3.0.0", "draft": False, "download_count": 10}, 200, "pallets/flask", "3.0.0")
        later = extract_fact("github", {"tag_name": "3.0.0", "draft": False, "download_count": 999}, 200, "pallets/flask", "3.0.0")
        self.assertEqual(published["reason"], "tag_published")
        self.assertTrue(facts_equivalent(published, later))
        draft = extract_fact("github", {"tag_name": "3.0.0", "draft": True}, 200, "pallets/flask", "3.0.0")
        self.assertEqual(draft["reason"], "draft_release")
        self.assertFalse(facts_equivalent(published, draft))
        limited = extract_fact("github", {"message": "API rate limit exceeded"}, 200, "pallets/flask", "3.0.0")
        self.assertEqual(limited["reason"], "github_message")
        self.assertTrue(reason_fits(limited["outcome"], limited["reason"]))

    def test_shape_rejects_a_match_with_the_wrong_reason(self):
        record = extract_fact("npm", {"name": "left-pad", "version": "1.3.0"}, 200, "left-pad", "1.3.0")
        self.assertTrue(fact_acceptable(record, "npm", "left-pad", "1.3.0", NPM_URL))
        record["reason"] = "not_found"
        self.assertFalse(fact_acceptable(record, "npm", "left-pad", "1.3.0", NPM_URL))


class WorkflowTests(unittest.TestCase):
    def test_gates_close_in_order_and_only_a_match_pays(self):
        gates = gates_of(RELEASE)
        self.assertTrue(advance_allowed("OPEN", gates, "1000", 10))
        self.assertFalse(attest_allowed("OPEN", gates, "1000", 10, SIGNER))
        missed = extract_fact("npm", {"error": "Not found"}, 404, "left-pad", "1.3.0")
        apply_fact(gates[0], missed, 10)
        self.assertEqual(gates[0]["state"], "open")
        self.assertEqual(gates[0]["reason"], "not_found")
        self.assertFalse(settle_allowed("OPEN", gates))
        self.assertFalse(refund_allowed("OPEN", gates, "1000", 10))
        self.assertTrue(refund_allowed("OPEN", gates, "1000", 1000))
        found = extract_fact("npm", {"name": "left-pad", "version": "1.3.0"}, 200, "left-pad", "1.3.0")
        apply_fact(gates[0], found, 20)
        self.assertEqual(gates[0]["state"], "closed")
        self.assertFalse(advance_allowed("OPEN", gates, "1000", 30))
        self.assertFalse(attest_allowed("OPEN", gates, "1000", 30, OTHER))
        self.assertTrue(attest_allowed("OPEN", gates, "1000", 30, SIGNER))
        apply_attest(gates[1], SIGNER, 30, "  release\nnotes  ")
        self.assertEqual(gates[1]["remark"], "release notes")
        self.assertTrue(settle_allowed("OPEN", gates))
        self.assertFalse(refund_allowed("OPEN", gates, "1000", 5000))
        self.assertFalse(advance_allowed("OPEN", gates, "1000", 40))
        self.assertFalse(advance_allowed("PAID", gates, "1000", 40))

    def test_deadline_blocks_a_late_gate_without_clawing_back_a_finished_run(self):
        gates = gates_of(RELEASE)
        self.assertFalse(advance_allowed("OPEN", gates, "1000", 1000))
        apply_fact(gates[0], extract_fact("npm", {"name": "left-pad", "version": "1.3.0"}, 200, "left-pad", "1.3.0"), 10)
        apply_attest(gates[1], SIGNER, 11, "")
        self.assertTrue(settle_allowed("OPEN", gates))
        self.assertFalse(refund_allowed("OPEN", gates, "50", 1000))

    def test_unwind_needs_both_parties_unless_they_are_the_same_account(self):
        self.assertEqual(flags_after_consent(SIGNER, SIGNER, OTHER, "0", "0"), ("1", "0"))
        self.assertFalse(unwind_ready("1", "0"))
        self.assertTrue(unwind_ready("1", "1"))
        same = flags_after_consent(SIGNER, SIGNER, SIGNER, "0", "0")
        self.assertEqual(same, ("1", "1"))
        self.assertTrue(unwind_ready(*same))


if __name__ == "__main__":
    unittest.main()
