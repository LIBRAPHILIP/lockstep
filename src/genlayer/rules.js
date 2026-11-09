/**
 * Client-side mirror of the manifest grammar in contracts/lockstep.py.
 * Funding still asks the contract to preview the spec and refuses to send
 * the deposit if the two parses disagree. Extraction stays in the contract.
 */

export const AUTHORITIES = ["npm", "pypi", "github"];
export const MIN_GATES = 2;
export const MAX_GATES = 5;
export const MIN_ESCROW_WEI = 10n ** 16n;
export const MIN_DEADLINE_SECS = 120;
export const MAX_DEADLINE_SECS = 30 * 24 * 3600;
export const MAX_SPEC_CHARS = 1200;
export const VERSION = "1.0.0-lockstep";

const NPM_UNSCOPED = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NPM_SCOPED = /^@[a-z0-9][a-z0-9._-]{0,31}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const PYPI = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,80}$/;
const PIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HOSTS = new Set(["registry.npmjs.org", "pypi.org", "api.github.com"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function pin(value, code) {
  const text = String(value || "").trim();
  if (text.includes("..") || text.startsWith(".") || text.endsWith(".") || !PIN.test(text)) {
    throw fail(code);
  }
  return text;
}

function parseNpmPkg(raw) {
  const pkg = String(raw || "").trim();
  if (pkg.includes("..") || pkg.includes("%") || pkg.includes("?") || pkg.includes("#")) {
    throw fail("bad_npm_package");
  }
  if (!NPM_UNSCOPED.test(pkg) && !NPM_SCOPED.test(pkg)) throw fail("bad_npm_package");
  if (pkg.length > 80) throw fail("bad_npm_package");
  return pkg;
}

function parsePypiPkg(raw) {
  const pkg = String(raw || "").trim().toLowerCase();
  if (pkg.includes("..") || pkg.startsWith(".") || pkg.endsWith(".")) throw fail("bad_pypi_package");
  if (!PYPI.test(pkg)) throw fail("bad_pypi_package");
  return pkg;
}

function parseGithubPkg(raw) {
  const pkg = String(raw || "").trim();
  const parts = pkg.split("/");
  if (parts.length !== 2) throw fail("bad_github_repo");
  const [owner, repo] = parts;
  if (repo.includes("..") || repo.startsWith(".") || repo.endsWith(".")) throw fail("bad_github_repo");
  if (!GH_OWNER.test(owner) || !GH_REPO.test(repo)) throw fail("bad_github_repo");
  const full = `${owner}/${repo}`;
  if (full.length > 100) throw fail("bad_github_repo");
  return full;
}

export function sourceUrl(authority, pkg, version) {
  if (authority === "npm") return `https://registry.npmjs.org/${pkg}/${version}`;
  if (authority === "pypi") return `https://pypi.org/pypi/${pkg}/${version}/json`;
  if (authority === "github") {
    const slash = pkg.indexOf("/");
    const owner = pkg.slice(0, slash);
    const repo = pkg.slice(slash + 1);
    return `https://api.github.com/repos/${owner}/${repo}/releases/tags/${version}`;
  }
  throw fail("bad_authority");
}

function parseFact(authority, pkg, version) {
  const auth = String(authority || "").trim().toLowerCase();
  if (!AUTHORITIES.includes(auth)) throw fail("bad_authority");
  let name;
  let pinned;
  if (auth === "npm") {
    name = parseNpmPkg(pkg);
    pinned = pin(version, "bad_version");
  } else if (auth === "pypi") {
    name = parsePypiPkg(pkg);
    pinned = pin(version, "bad_version");
  } else {
    name = parseGithubPkg(pkg);
    pinned = pin(version, "bad_tag");
  }
  return { kind: "fact", authority: auth, pkg: name, version: pinned, source: sourceUrl(auth, name, pinned) };
}

export function normalizeAddress(raw) {
  let text = String(raw || "").trim();
  if (text.slice(0, 2).toLowerCase() === "0x") text = `0x${text.slice(2)}`;
  if (!ADDRESS.test(text)) throw fail("bad_address");
  const lowered = text.toLowerCase();
  if (lowered === `0x${"0".repeat(40)}`) throw fail("bad_address");
  return lowered;
}

export function parseManifest(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.length > MAX_SPEC_CHARS) throw fail("spec_too_long");
  const gates = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const parts = stripped.split(/\s+/);
    const verb = parts[0].toLowerCase();
    if (verb === "fact") {
      if (parts.length !== 4) throw fail("bad_line");
      gates.push(parseFact(parts[1], parts[2], parts[3]));
    } else if (verb === "attest") {
      if (parts.length !== 2) throw fail("bad_line");
      gates.push({ kind: "attest", signer: normalizeAddress(parts[1]) });
    } else {
      throw fail("bad_line");
    }
  }
  if (gates.length < MIN_GATES) throw fail("too_few_gates");
  if (gates.length > MAX_GATES) throw fail("too_many_gates");
  if (!gates.some((gate) => gate.kind === "fact")) throw fail("need_fact_gate");
  return gates;
}

export function canonicalSpec(gates) {
  return gates
    .map((gate) =>
      gate.kind === "fact"
        ? `fact ${gate.authority} ${gate.pkg} ${gate.version}`
        : `attest ${gate.signer}`
    )
    .join("\n");
}

export function tryParseManifest(raw) {
  try {
    const gates = parseManifest(raw);
    return { ok: true, gates, spec: canonicalSpec(gates), error: "" };
  } catch (error) {
    return { ok: false, gates: [], spec: "", error: error.code || error.message || "bad_spec" };
  }
}

export function sameManifest(localGates, remoteGates) {
  if (!Array.isArray(localGates) || !Array.isArray(remoteGates)) return false;
  if (localGates.length !== remoteGates.length) return false;
  for (let i = 0; i < localGates.length; i += 1) {
    const local = localGates[i];
    const remote = remoteGates[i];
    if (local.kind !== remote.kind) return false;
    if (local.kind === "fact") {
      if (
        local.authority !== remote.authority ||
        local.pkg !== remote.pkg ||
        local.version !== remote.version ||
        local.source !== remote.source
      ) {
        return false;
      }
    } else if (local.signer !== remote.signer) {
      return false;
    }
  }
  return true;
}

export function parseDeadline(raw) {
  const text = String(raw || "").trim();
  if (!/^[0-9]{1,8}$/.test(text)) throw fail("bad_deadline");
  const secs = Number(text);
  if (secs < MIN_DEADLINE_SECS) throw fail("deadline_too_short");
  if (secs > MAX_DEADLINE_SECS) throw fail("deadline_too_long");
  return secs;
}

export function parseGenToWei(text) {
  const raw = String(text || "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw fail("bad_amount");
  const [whole, frac = ""] = raw.split(".");
  const padded = `${frac}${"0".repeat(18)}`.slice(0, 18);
  const wei = BigInt(whole) * 10n ** 18n + BigInt(padded);
  if (wei < MIN_ESCROW_WEI) throw fail("escrow_too_small");
  return wei;
}

export function formatGen(wei) {
  const value = BigInt(wei || 0);
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function safeHttpsHref(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function isAddress(value) {
  try {
    normalizeAddress(value);
    return true;
  } catch {
    return false;
  }
}

export function short(value) {
  const text = String(value || "");
  if (text.length < 14) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function nextGate(gates) {
  if (!Array.isArray(gates)) return null;
  return gates.find((gate) => gate.state !== "closed") || null;
}

export function allClosed(gates) {
  return Array.isArray(gates) && gates.length > 0 && gates.every((gate) => gate.state === "closed");
}

const ERROR_TEXT = [
  ["escrow_too_small", "The deposit has to be at least 0.01 GEN."],
  ["too_few_gates", "A run needs at least two gates, and one of them has to be a fact."],
  ["too_many_gates", "A run can have at most five gates."],
  ["need_fact_gate", "Add a fact gate. A run made only of signatures is not a Lockstep workflow."],
  ["bad_npm_package", "npm names are lowercase. Scoped names look like @scope/name, with no .. or spaces."],
  ["bad_pypi_package", "PyPI names are lowercase letters, numbers, dots, underscores, or hyphens."],
  ["bad_github_repo", "GitHub facts use owner/repo as one token, with a single slash."],
  ["bad_version", "Pin the published version. Use letters, numbers, dots, underscores, or hyphens."],
  ["bad_tag", "Pin the release tag. Use letters, numbers, dots, underscores, or hyphens."],
  ["bad_address", "Use a non-zero 0x account address."],
  ["bad_authority", "Fact authorities are npm, pypi, and github."],
  ["bad_line", "Each line is `fact <authority> <name> <version>` or `attest <address>`."],
  ["bad_deadline", "Deadline has to be a whole number of seconds."],
  ["deadline_too_short", "Deadline has to be at least two minutes."],
  ["deadline_too_long", "Deadline has to be 30 days or less."],
  ["bad_title", "Give the run a title, up to 60 characters."],
  ["bad_note", "The note has to be 160 characters or fewer."],
  ["bad_remark", "The attest remark has to be 80 characters or fewer."],
  ["spec_too_long", "The manifest is too long."],
  ["not_open", "That run is already settled."],
  ["deadline_passed", "The deadline has passed, so this gate can no longer close."],
  ["deadline_open", "Refund opens when the deadline passes with a gate still open."],
  ["gates_open", "Settle pays only after every gate is closed."],
  ["gates_already_closed", "Every gate is closed. Settle pays the payee. Refund will not take it back."],
  ["awaiting_attestation", "The next gate is a signature. The named account has to attest."],
  ["awaiting_fact", "The next gate is a registry fact. Advance it. A signature cannot skip it."],
  ["not_signer", "Only the account named on this gate can attest."],
  ["not_party", "Only the sponsor or the payee can consent to unwind."],
  ["consent_incomplete", "Unwind waits until both the sponsor and the payee have consented."],
  ["no_open_gate", "There is no open gate left."],
  ["run_not_found", "That run is not on this contract."],
  ["unexpected_value", "That call does not accept a GEN transfer."],
  ["invalid_consensus_payload", "Validators did not accept the registry record. Nothing was written."],
  ["fact_not_for_gate", "The registry record did not match this gate."],
  ["manifest_mismatch", "The contract parsed a different manifest from this form. Funding was not sent."],
];

export function errorText(error) {
  const raw = String(error?.message || error || "");
  for (const [code, text] of ERROR_TEXT) {
    if (raw.includes(code)) return text;
  }
  return raw;
}
