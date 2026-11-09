# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Lockstep — sealed workflow automation for a release checklist.

A sponsor funds an ordered manifest. After that transaction the manifest
cannot be edited, reordered, or ticked from the interface. Each gate is one
of two kinds:

  fact    The contract builds an HTTPS URL on npm, PyPI, or the GitHub
          Releases API. Validators independently fetch it and keep only a
          small decision record. The gate closes only when that record is a
          match. An unreadable source does not close the gate and does not
          release the funds.
  attest  The named account submits a transaction. That is a signature, not
          a claim about the web.

Gates close strictly in order. GEN is paid to the payee only when every gate
is closed. If the deadline passes with a gate still open, anyone can refund
the sponsor. Both parties can consent to unwind early. The LLM is not called.
The sponsor does not get to choose the URL.
"""

from genlayer import *

import json
import time
import typing


# RULES_START
import json
import re

VERSION = "1.0.0-lockstep"
AUTHORITIES = ("npm", "pypi", "github")
MIN_GATES = 2
MAX_GATES = 5
MIN_ESCROW_WEI = 10**16
MIN_DEADLINE_SECS = 120
MAX_DEADLINE_SECS = 30 * 24 * 3600
MAX_SPEC_CHARS = 1200
BODY_CAP = 350000

OUTCOMES = ("match", "absent", "mismatch", "unreadable")
MATCH_REASONS = ("name_version_match", "tag_published")
ABSENT_REASONS = ("not_found",)
MISMATCH_REASONS = ("draft_release", "yanked", "name_mismatch", "version_mismatch", "tag_mismatch")
UNREADABLE_REASONS = (
    "bad_json",
    "not_object",
    "body_too_large",
    "not_json",
    "github_message",
    "empty_body",
    "fetch_failed",
    "http_error",
    "missing_fields",
)
REASONS = MATCH_REASONS + ABSENT_REASONS + MISMATCH_REASONS + UNREADABLE_REASONS
DECISION_FIELDS = (
    "authority",
    "pkg",
    "version",
    "source",
    "outcome",
    "reason",
    "observed_name",
    "observed_version",
)

_NPM_UNSCOPED = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_NPM_SCOPED = re.compile(r"^@[a-z0-9][a-z0-9._-]{0,31}/[a-z0-9][a-z0-9._-]{0,63}$")
_PYPI = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_GH_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
_GH_REPO = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_PIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
_SECS = re.compile(r"^[0-9]{1,8}$")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def reason_fits(outcome: str, reason: str) -> bool:
    if outcome == "match":
        return reason in MATCH_REASONS
    if outcome == "absent":
        return reason in ABSENT_REASONS
    if outcome == "mismatch":
        return reason in MISMATCH_REASONS
    if outcome == "unreadable":
        return reason in UNREADABLE_REASONS
    return False


def _pin(value: str, code: str) -> str:
    text = (value or "").strip()
    if ".." in text or text.startswith(".") or text.endswith(".") or not _PIN.match(text):
        raise ValueError(code)
    return text


def parse_npm_pkg(raw: str) -> str:
    pkg = (raw or "").strip()
    if ".." in pkg or "%" in pkg or "?" in pkg or "#" in pkg:
        raise ValueError("bad_npm_package")
    if not (_NPM_UNSCOPED.match(pkg) or _NPM_SCOPED.match(pkg)):
        raise ValueError("bad_npm_package")
    if len(pkg) > 80:
        raise ValueError("bad_npm_package")
    return pkg


def parse_pypi_pkg(raw: str) -> str:
    pkg = (raw or "").strip().lower()
    if ".." in pkg or pkg.startswith(".") or pkg.endswith("."):
        raise ValueError("bad_pypi_package")
    if not _PYPI.match(pkg):
        raise ValueError("bad_pypi_package")
    return pkg


def parse_github_pkg(raw: str) -> str:
    pkg = (raw or "").strip()
    if pkg.count("/") != 1:
        raise ValueError("bad_github_repo")
    owner, repo = pkg.split("/", 1)
    if ".." in repo or repo.startswith(".") or repo.endswith("."):
        raise ValueError("bad_github_repo")
    if not _GH_OWNER.match(owner) or not _GH_REPO.match(repo):
        raise ValueError("bad_github_repo")
    full = owner + "/" + repo
    if len(full) > 100:
        raise ValueError("bad_github_repo")
    return full


def source_url(authority: str, pkg: str, version: str) -> str:
    if authority == "npm":
        return "https://registry.npmjs.org/" + pkg + "/" + version
    if authority == "pypi":
        return "https://pypi.org/pypi/" + pkg + "/" + version + "/json"
    if authority == "github":
        owner, repo = pkg.split("/", 1)
        return (
            "https://api.github.com/repos/"
            + owner
            + "/"
            + repo
            + "/releases/tags/"
            + version
        )
    raise ValueError("bad_authority")


def parse_fact(authority: str, pkg: str, version: str) -> dict:
    auth = (authority or "").strip().lower()
    if auth not in AUTHORITIES:
        raise ValueError("bad_authority")
    if auth == "npm":
        name = parse_npm_pkg(pkg)
        pin = _pin(version, "bad_version")
    elif auth == "pypi":
        name = parse_pypi_pkg(pkg)
        pin = _pin(version, "bad_version")
    else:
        name = parse_github_pkg(pkg)
        pin = _pin(version, "bad_tag")
    return {
        "kind": "fact",
        "authority": auth,
        "pkg": name,
        "version": pin,
        "source": source_url(auth, name, pin),
    }


def normalize_address(raw: str) -> str:
    text = (raw or "").strip()
    if text[:2].lower() == "0x":
        text = "0x" + text[2:]
    if not _ADDRESS.match(text):
        raise ValueError("bad_address")
    lowered = text.lower()
    if lowered == "0x" + ("0" * 40):
        raise ValueError("bad_address")
    return lowered


def parse_attest(raw: str) -> dict:
    return {"kind": "attest", "signer": normalize_address(raw)}


def parse_manifest(raw: str) -> list:
    text = (raw or "").replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > MAX_SPEC_CHARS:
        raise ValueError("spec_too_long")
    gates = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        verb = parts[0].lower()
        if verb == "fact":
            if len(parts) != 4:
                raise ValueError("bad_line")
            gates.append(parse_fact(parts[1], parts[2], parts[3]))
        elif verb == "attest":
            if len(parts) != 2:
                raise ValueError("bad_line")
            gates.append(parse_attest(parts[1]))
        else:
            raise ValueError("bad_line")
    if len(gates) < MIN_GATES:
        raise ValueError("too_few_gates")
    if len(gates) > MAX_GATES:
        raise ValueError("too_many_gates")
    if not any(gate["kind"] == "fact" for gate in gates):
        raise ValueError("need_fact_gate")
    return gates


def canonical_spec(gates: list) -> str:
    lines = []
    for gate in gates:
        if gate.get("kind") == "fact":
            lines.append(
                "fact " + gate["authority"] + " " + gate["pkg"] + " " + gate["version"]
            )
        else:
            lines.append("attest " + gate["signer"])
    return "\n".join(lines)


def clip_text(raw: str, limit: int, code: str, required: bool, min_len: int) -> str:
    text = (raw or "").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    text = "".join(ch for ch in text if ch >= " " and ch != "\x7f")
    text = " ".join(text.split())
    if required and len(text) < min_len:
        raise ValueError(code)
    if len(text) > limit:
        raise ValueError(code)
    return text


def parse_deadline(raw: str) -> int:
    text = (raw or "").strip()
    if not _SECS.match(text):
        raise ValueError("bad_deadline")
    secs = int(text)
    if secs < MIN_DEADLINE_SECS:
        raise ValueError("deadline_too_short")
    if secs > MAX_DEADLINE_SECS:
        raise ValueError("deadline_too_long")
    return secs


def fresh_gate(parsed: dict) -> dict:
    gate = {
        "kind": parsed["kind"],
        "state": "open",
        "reason": "",
        "outcome": "",
        "observed_name": "",
        "observed_version": "",
        "remark": "",
        "closed_at": "0",
        "checked_at": "0",
    }
    if parsed["kind"] == "fact":
        gate["authority"] = parsed["authority"]
        gate["pkg"] = parsed["pkg"]
        gate["version"] = parsed["version"]
        gate["source"] = parsed["source"]
        gate["signer"] = ""
    else:
        gate["authority"] = ""
        gate["pkg"] = ""
        gate["version"] = ""
        gate["source"] = ""
        gate["signer"] = parsed["signer"]
    return gate


def next_index(gates: list) -> int:
    for index, gate in enumerate(gates):
        if gate.get("state") != "closed":
            return index
    return -1


def all_closed(gates: list) -> bool:
    return bool(gates) and all(gate.get("state") == "closed" for gate in gates)


def advance_allowed(status: str, gates: list, deadline_at: str, now: int) -> bool:
    if status != "OPEN":
        return False
    if int(now) >= int(deadline_at):
        return False
    index = next_index(gates)
    if index < 0:
        return False
    return gates[index].get("kind") == "fact"


def attest_allowed(status: str, gates: list, deadline_at: str, now: int, sender: str) -> bool:
    if status != "OPEN":
        return False
    if int(now) >= int(deadline_at):
        return False
    index = next_index(gates)
    if index < 0:
        return False
    gate = gates[index]
    return gate.get("kind") == "attest" and gate.get("signer") == sender


def settle_allowed(status: str, gates: list) -> bool:
    return status == "OPEN" and all_closed(gates)


def refund_allowed(status: str, gates: list, deadline_at: str, now: int) -> bool:
    if status != "OPEN":
        return False
    if all_closed(gates):
        return False
    return int(now) >= int(deadline_at)


def flags_after_consent(sender: str, sponsor: str, payee: str, sponsor_flag: str, payee_flag: str) -> tuple:
    sponsor_next = sponsor_flag
    payee_next = payee_flag
    if sender == sponsor:
        sponsor_next = "1"
    if sender == payee:
        payee_next = "1"
    return sponsor_next, payee_next


def unwind_ready(sponsor_flag: str, payee_flag: str) -> bool:
    return sponsor_flag == "1" and payee_flag == "1"


def _clip_observed(value) -> str:
    text = str(value or "")
    text = "".join(ch for ch in text if ch >= " " and ch != "\x7f")
    if len(text) > 120:
        text = text[:120]
    return text


def _blank(authority: str, pkg: str, version: str, source: str) -> dict:
    return {
        "authority": authority,
        "pkg": pkg,
        "version": version,
        "source": source,
        "outcome": "unreadable",
        "reason": "fetch_failed",
        "observed_name": "",
        "observed_version": "",
    }


def _load_json(body):
    if isinstance(body, dict):
        return body
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", errors="replace")
    text = str(body or "").strip()
    if not text:
        raise ValueError("empty_body")
    if text[0] not in "{[":
        raise ValueError("not_json")
    if len(text) > BODY_CAP:
        raise ValueError("body_too_large")
    try:
        data = json.loads(text)
    except Exception:
        raise ValueError("bad_json")
    if not isinstance(data, dict):
        raise ValueError("not_object")
    return data


def _status_gate(rec: dict, status: int) -> bool:
    code = int(status or 0)
    if code == 0:
        rec["outcome"] = "unreadable"
        rec["reason"] = "fetch_failed"
        return True
    if code == 404:
        rec["outcome"] = "absent"
        rec["reason"] = "not_found"
        return True
    if code >= 400:
        rec["outcome"] = "unreadable"
        rec["reason"] = "http_error"
        return True
    return False


def extract_npm(body, status: int, pkg: str, version: str, source: str) -> dict:
    rec = _blank("npm", pkg, version, source)
    if _status_gate(rec, status):
        return rec
    try:
        data = _load_json(body)
    except ValueError as exc:
        rec["outcome"] = "unreadable"
        rec["reason"] = str(exc)
        return rec
    if "error" in data and "version" not in data:
        err = str(data.get("error") or "").lower()
        if "not found" in err:
            rec["outcome"] = "absent"
            rec["reason"] = "not_found"
        else:
            rec["outcome"] = "unreadable"
            rec["reason"] = "missing_fields"
        return rec
    name = _clip_observed(data.get("name"))
    ver = _clip_observed(data.get("version"))
    rec["observed_name"] = name
    rec["observed_version"] = ver
    if not name or not ver:
        rec["outcome"] = "unreadable"
        rec["reason"] = "missing_fields"
        return rec
    if name != pkg:
        rec["outcome"] = "mismatch"
        rec["reason"] = "name_mismatch"
        return rec
    if ver != version:
        rec["outcome"] = "mismatch"
        rec["reason"] = "version_mismatch"
        return rec
    rec["outcome"] = "match"
    rec["reason"] = "name_version_match"
    return rec


def extract_pypi(body, status: int, pkg: str, version: str, source: str) -> dict:
    rec = _blank("pypi", pkg, version, source)
    if _status_gate(rec, status):
        return rec
    try:
        data = _load_json(body)
    except ValueError as exc:
        rec["outcome"] = "unreadable"
        rec["reason"] = str(exc)
        return rec
    if "message" in data and "info" not in data:
        msg = str(data.get("message") or "").lower()
        if "not found" in msg:
            rec["outcome"] = "absent"
            rec["reason"] = "not_found"
        else:
            rec["outcome"] = "unreadable"
            rec["reason"] = "missing_fields"
        return rec
    info = data.get("info")
    if not isinstance(info, dict):
        rec["outcome"] = "unreadable"
        rec["reason"] = "missing_fields"
        return rec
    name = _clip_observed(info.get("name"))
    ver = _clip_observed(info.get("version"))
    rec["observed_name"] = name
    rec["observed_version"] = ver
    if info.get("yanked") is True:
        rec["outcome"] = "mismatch"
        rec["reason"] = "yanked"
        return rec
    if not name or not ver:
        rec["outcome"] = "unreadable"
        rec["reason"] = "missing_fields"
        return rec
    if name.lower() != pkg.lower():
        rec["outcome"] = "mismatch"
        rec["reason"] = "name_mismatch"
        return rec
    if ver != version:
        rec["outcome"] = "mismatch"
        rec["reason"] = "version_mismatch"
        return rec
    rec["outcome"] = "match"
    rec["reason"] = "name_version_match"
    return rec


def extract_github(body, status: int, pkg: str, version: str, source: str) -> dict:
    rec = _blank("github", pkg, version, source)
    if _status_gate(rec, status):
        return rec
    try:
        data = _load_json(body)
    except ValueError as exc:
        rec["outcome"] = "unreadable"
        rec["reason"] = str(exc)
        return rec
    if "tag_name" not in data:
        rec["outcome"] = "unreadable"
        rec["reason"] = "github_message" if "message" in data else "missing_fields"
        return rec
    tag = _clip_observed(data.get("tag_name"))
    rec["observed_name"] = pkg
    rec["observed_version"] = tag
    if data.get("draft") is True:
        rec["outcome"] = "mismatch"
        rec["reason"] = "draft_release"
        return rec
    if tag != version:
        rec["outcome"] = "mismatch"
        rec["reason"] = "tag_mismatch"
        return rec
    rec["outcome"] = "match"
    rec["reason"] = "tag_published"
    return rec


def extract_fact(authority: str, body, status: int, pkg: str, version: str) -> dict:
    source = source_url(authority, pkg, version)
    if authority == "npm":
        return extract_npm(body, status, pkg, version, source)
    if authority == "pypi":
        return extract_pypi(body, status, pkg, version, source)
    if authority == "github":
        return extract_github(body, status, pkg, version, source)
    raise ValueError("bad_authority")


def facts_equivalent(left: dict, right: dict) -> bool:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    for field in DECISION_FIELDS:
        if str(left.get(field)) != str(right.get(field)):
            return False
    return True


def fact_acceptable(record: dict, authority: str, pkg: str, version: str, source: str) -> bool:
    if not isinstance(record, dict):
        return False
    for field in DECISION_FIELDS:
        if not isinstance(record.get(field), str):
            return False
    if record["authority"] != authority or record["pkg"] != pkg or record["version"] != version:
        return False
    if record["source"] != source:
        return False
    if record["outcome"] not in OUTCOMES:
        return False
    if not reason_fits(record["outcome"], record["reason"]):
        return False
    if len(record["observed_name"]) > 120 or len(record["observed_version"]) > 120:
        return False
    return True


def apply_fact(gate: dict, record: dict, now: int) -> dict:
    if gate.get("kind") != "fact":
        raise ValueError("not_fact_gate")
    if not fact_acceptable(record, gate["authority"], gate["pkg"], gate["version"], gate["source"]):
        raise ValueError("fact_not_for_gate")
    gate["outcome"] = record["outcome"]
    gate["reason"] = record["reason"]
    gate["observed_name"] = record["observed_name"]
    gate["observed_version"] = record["observed_version"]
    gate["checked_at"] = str(int(now))
    if record["outcome"] == "match":
        gate["state"] = "closed"
        gate["closed_at"] = str(int(now))
    return gate


def apply_attest(gate: dict, sender: str, now: int, remark: str) -> dict:
    if gate.get("kind") != "attest":
        raise ValueError("not_attest_gate")
    if gate.get("state") == "closed":
        raise ValueError("gate_closed")
    if gate.get("signer") != sender:
        raise ValueError("not_signer")
    gate["state"] = "closed"
    gate["reason"] = "signed"
    gate["outcome"] = "signed"
    gate["remark"] = clip_text(remark, 80, "bad_remark", False, 0)
    gate["closed_at"] = str(int(now))
    gate["checked_at"] = str(int(now))
    return gate

# RULES_END


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class Lockstep(gl.Contract):
    run_count: u256
    runs: TreeMap[str, str]
    version: str
    title: str

    def __init__(self):
        self.run_count = u256(0)
        self.version = VERSION
        self.title = "Lockstep"

    @gl.public.view
    def get_meta(self) -> dict[str, str]:
        return {
            "title": self.title,
            "version": self.version,
            "run_count": str(self.run_count),
            "primitive": "sealed-workflow-runner",
            "category": "workflow-automation",
            "llm_rule": "none",
            "source_rule": "contract_built_https_only",
            "order_rule": "gates_close_in_order",
            "edit_rule": "manifest_frozen_at_fund",
            "pay_rule": "all_gates_closed",
            "refund_rule": "deadline_with_open_gate",
            "unwind_rule": "sponsor_and_payee_consent",
            "fail_rule": "unreadable_does_not_close",
            "authorities": ",".join(AUTHORITIES),
            "min_escrow_wei": str(MIN_ESCROW_WEI),
            "min_deadline_secs": str(MIN_DEADLINE_SECS),
            "max_deadline_secs": str(MAX_DEADLINE_SECS),
            "min_gates": str(MIN_GATES),
            "max_gates": str(MAX_GATES),
        }

    @gl.public.view
    def describe(self) -> dict[str, str]:
        return {
            "name": "Lockstep",
            "problem": "A workflow that pays someone is usually owned by the person who can edit the steps. Lockstep freezes the manifest when the sponsor deposits GEN.",
            "fact_gate": "Validators re-fetch a contract-built npm, PyPI, or GitHub Releases URL and close the gate only on a match.",
            "attest_gate": "The named account signs. The signature is not evidence about the registry.",
            "order": "A later gate cannot close while an earlier gate is open.",
            "pays_on": "every gate closed, via settle, to the payee",
            "refunds_on": "deadline passed with a gate still open, to the sponsor",
            "unreadable": "does not close a gate and does not refund before the deadline",
            "llm": "not used",
            "not_accepted": "a URL chosen by the sponsor",
        }

    @gl.public.view
    def get_run_count(self) -> u256:
        return self.run_count

    @gl.public.view
    def get_run(self, run_id: str) -> str:
        rec = self._read(run_id)
        if rec is None:
            return json.dumps({"error": "run_not_found", "run_id": str(run_id)})
        return json.dumps(rec, sort_keys=True)

    @gl.public.view
    def list_runs(self, offset: u256, limit: u256) -> typing.Any:
        off = max(0, int(offset))
        lim = int(limit)
        if lim <= 0:
            lim = 10
        if lim > 20:
            lim = 20
        total = int(self.run_count)
        out = []
        idx = total - 1 - off
        while idx >= 0 and len(out) < lim:
            key = str(idx)
            if key in self.runs:
                out.append(self.runs[key])
            idx -= 1
        return out

    @gl.public.view
    def preview_manifest(self, spec: str) -> str:
        try:
            gates = parse_manifest(spec or "")
        except ValueError as exc:
            return json.dumps({"error": str(exc)})
        out = []
        for gate in gates:
            if gate["kind"] == "fact":
                out.append(
                    {
                        "kind": "fact",
                        "authority": gate["authority"],
                        "pkg": gate["pkg"],
                        "version": gate["version"],
                        "source": gate["source"],
                    }
                )
            else:
                out.append({"kind": "attest", "signer": gate["signer"]})
        return json.dumps({"gates": out, "spec": canonical_spec(gates)}, sort_keys=True)

    @gl.public.write.payable
    def fund_run(self, title: str, note: str, payee: str, deadline_secs: str, spec: str) -> str:
        try:
            parsed = parse_manifest(spec or "")
            gates = [fresh_gate(gate) for gate in parsed]
            title_text = clip_text(title, 60, "bad_title", True, 2)
            note_text = clip_text(note, 160, "bad_note", False, 0)
            payee_addr = normalize_address(payee)
            secs = parse_deadline(deadline_secs)
        except ValueError as exc:
            raise Exception(str(exc))
        escrow = int(gl.message.value)
        if escrow < MIN_ESCROW_WEI:
            raise Exception("escrow_too_small")
        now = _now_ts()
        run_id = str(int(self.run_count))
        rec = {
            "run_id": run_id,
            "status": "OPEN",
            "title": title_text,
            "note": note_text,
            "sponsor": self._sender(),
            "payee": payee_addr,
            "escrow_wei": str(escrow),
            "opened_at": str(now),
            "deadline_at": str(now + secs),
            "deadline_secs": str(secs),
            "spec": canonical_spec(gates),
            "gates": gates,
            "sponsor_unwind": "0",
            "payee_unwind": "0",
            "settlement_basis": "",
            "last_reason": "funded",
        }
        self._write(rec)
        self.run_count = u256(int(self.run_count) + 1)
        return json.dumps(
            {"run_id": run_id, "status": "OPEN", "escrow_wei": str(escrow)},
            sort_keys=True,
        )

    @gl.public.write
    def advance(self, run_id: str) -> str:
        self._reject_value()
        rec = self._require(run_id)
        now = _now_ts()
        if not advance_allowed(rec["status"], rec["gates"], rec["deadline_at"], now):
            self._raise_blocked(rec, now, "fact")
        index = next_index(rec["gates"])
        gate = rec["gates"][index]
        record = self._consensus_fact(gate["authority"], gate["pkg"], gate["version"], gate["source"])
        try:
            apply_fact(gate, record, now)
        except ValueError as exc:
            raise Exception(str(exc))
        rec["gates"][index] = gate
        rec["last_reason"] = record["reason"]
        self._write(rec)
        return json.dumps(
            {
                "run_id": rec["run_id"],
                "gate": str(index),
                "outcome": record["outcome"],
                "reason": record["reason"],
                "state": gate["state"],
            },
            sort_keys=True,
        )

    @gl.public.write
    def attest(self, run_id: str, remark: str) -> str:
        self._reject_value()
        rec = self._require(run_id)
        now = _now_ts()
        sender = self._sender()
        if not attest_allowed(rec["status"], rec["gates"], rec["deadline_at"], now, sender):
            self._raise_blocked(rec, now, "attest")
        index = next_index(rec["gates"])
        try:
            apply_attest(rec["gates"][index], sender, now, remark or "")
        except ValueError as exc:
            raise Exception(str(exc))
        rec["last_reason"] = "signed"
        self._write(rec)
        return json.dumps({"run_id": rec["run_id"], "gate": str(index), "state": "closed"}, sort_keys=True)

    @gl.public.write
    def settle(self, run_id: str) -> str:
        self._reject_value()
        rec = self._require(run_id)
        if not settle_allowed(rec["status"], rec["gates"]):
            if rec["status"] != "OPEN":
                raise Exception("not_open")
            raise Exception("gates_open")
        self._finish(rec, "PAID", "all_gates_closed", rec["payee"])
        return "PAID"

    @gl.public.write
    def refund(self, run_id: str) -> str:
        self._reject_value()
        rec = self._require(run_id)
        now = _now_ts()
        if not refund_allowed(rec["status"], rec["gates"], rec["deadline_at"], now):
            if rec["status"] != "OPEN":
                raise Exception("not_open")
            if all_closed(rec["gates"]):
                raise Exception("gates_already_closed")
            raise Exception("deadline_open")
        self._finish(rec, "REFUNDED", "deadline_passed", rec["sponsor"])
        return "REFUNDED"

    @gl.public.write
    def consent_unwind(self, run_id: str) -> str:
        self._reject_value()
        rec = self._require(run_id)
        if rec["status"] != "OPEN":
            raise Exception("not_open")
        sender = self._sender()
        if sender != rec["sponsor"] and sender != rec["payee"]:
            raise Exception("not_party")
        sponsor_flag, payee_flag = flags_after_consent(
            sender,
            rec["sponsor"],
            rec["payee"],
            rec["sponsor_unwind"],
            rec["payee_unwind"],
        )
        rec["sponsor_unwind"] = sponsor_flag
        rec["payee_unwind"] = payee_flag
        rec["last_reason"] = "consent"
        self._write(rec)
        return json.dumps(
            {
                "run_id": rec["run_id"],
                "sponsor_unwind": rec["sponsor_unwind"],
                "payee_unwind": rec["payee_unwind"],
            },
            sort_keys=True,
        )

    @gl.public.write
    def unwind(self, run_id: str) -> str:
        self._reject_value()
        rec = self._require(run_id)
        if rec["status"] != "OPEN":
            raise Exception("not_open")
        if not unwind_ready(rec["sponsor_unwind"], rec["payee_unwind"]):
            raise Exception("consent_incomplete")
        self._finish(rec, "UNWOUND", "mutual_unwind", rec["sponsor"])
        return "UNWOUND"

    def _raise_blocked(self, rec: dict, now: int, expected: str) -> None:
        if rec["status"] != "OPEN":
            raise Exception("not_open")
        if int(now) >= int(rec["deadline_at"]):
            raise Exception("deadline_passed")
        index = next_index(rec["gates"])
        if index < 0:
            raise Exception("no_open_gate")
        kind = rec["gates"][index].get("kind")
        if expected == "attest" and kind == "attest":
            raise Exception("not_signer")
        if kind == "attest":
            raise Exception("awaiting_attestation")
        raise Exception("awaiting_fact")

    def _finish(self, rec: dict, status: str, basis: str, payee: str) -> None:
        amount = int(rec["escrow_wei"])
        rec["escrow_wei"] = "0"
        rec["status"] = status
        rec["settlement_basis"] = basis
        rec["last_reason"] = basis
        self._write(rec)
        self._pay(payee, amount)

    def _consensus_fact(self, authority: str, pkg: str, version: str, source: str) -> dict:
        auth = authority
        name = pkg
        pin = version
        url = source

        def leader_fn():
            return _fetch_fact(auth, name, pin)

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            proposed = leader_result.calldata
            if not fact_acceptable(proposed, auth, name, pin, url):
                return False
            try:
                mine = leader_fn()
            except Exception:
                return False
            return facts_equivalent(proposed, mine)

        payload = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        if not fact_acceptable(payload, auth, name, pin, url):
            raise Exception("invalid_consensus_payload")
        return payload

    def _read(self, run_id: str):
        key = str(run_id).strip()
        if key not in self.runs:
            return None
        try:
            rec = json.loads(self.runs[key])
        except Exception:
            return None
        if not isinstance(rec, dict):
            return None
        return rec

    def _require(self, run_id: str) -> dict:
        rec = self._read(run_id)
        if rec is None:
            raise Exception("run_not_found")
        return rec

    def _write(self, rec: dict) -> None:
        self.runs[str(rec["run_id"])] = json.dumps(rec, sort_keys=True)

    def _sender(self) -> str:
        return gl.message.sender_address.as_hex.lower()

    def _reject_value(self) -> None:
        if int(gl.message.value) != 0:
            raise Exception("unexpected_value")

    def _pay(self, to_hex: str, amount: int) -> None:
        if int(amount) <= 0 or not to_hex:
            return
        _Recipient(Address(to_hex)).emit_transfer(value=u256(int(amount)))


def _now_ts() -> int:
    return int(time.time())


def _fetch_fact(authority: str, pkg: str, version: str) -> dict:
    url = source_url(authority, pkg, version)
    status, body = _http_get(url)
    return extract_fact(authority, body, status, pkg, version)


def _http_get(url: str) -> tuple:
    try:
        res = gl.nondet.web.get(url)
    except Exception:
        return 0, ""
    if isinstance(res, str):
        return 200, res
    if isinstance(res, (bytes, bytearray)):
        return 200, res.decode("utf-8", errors="replace")
    if isinstance(res, dict):
        status = int(res.get("status_code") or res.get("status") or 200)
        raw = res.get("body", "")
    else:
        status = int(getattr(res, "status_code", 200) or 200)
        raw = getattr(res, "body", b"")
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    text = str(raw or "")
    if status >= 400 and text[:1] not in ("{", "["):
        return status, ""
    return status, text
