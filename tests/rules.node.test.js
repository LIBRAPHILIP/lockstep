import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSpec, parseManifest, safeHttpsHref, sourceUrl, tryParseManifest } from "../src/genlayer/rules.js";

const SIGNER = `0x${"11".repeat(20)}`;
const NPM_URL = "https://registry.npmjs.org/left-pad/1.3.0";

test("release manifest matches the contract canonical spec", () => {
  const gates = parseManifest(`  Fact   npm   left-pad   1.3.0  \r\n# note\n\nattest ${SIGNER.toUpperCase()}\n`);
  assert.equal(canonicalSpec(gates), `fact npm left-pad 1.3.0\nattest ${SIGNER}`);
  assert.equal(gates[0].source, NPM_URL);
  assert.equal(gates[1].signer, SIGNER);
});

test("registry urls are the contract hosts", () => {
  const gates = parseManifest("fact npm @scope/pkg 1.2.3\nfact pypi Six 1.16.0\nfact github pallets/flask 3.0.0\n");
  assert.equal(gates[0].source, "https://registry.npmjs.org/@scope/pkg/1.2.3");
  assert.equal(gates[1].source, "https://pypi.org/pypi/six/1.16.0/json");
  assert.equal(gates[2].source, sourceUrl("github", "pallets/flask", "3.0.0"));
  assert.equal(gates[2].source, "https://api.github.com/repos/pallets/flask/releases/tags/3.0.0");
});

test("hostile specs fail closed", () => {
  const samples = [
    ["fact npm left-pad 1.3.0\n", "too_few_gates"],
    [`attest ${SIGNER}\nattest 0x${"22".repeat(20)}\n`, "need_fact_gate"],
    ["fact npm ../left-pad 1.3.0\nfact npm left-pad 1.3.0\n", "bad_npm_package"],
    ["fact http example.com 1.0.0\nfact npm left-pad 1.3.0\n", "bad_authority"],
    ["fact github pallets/flask/extra 3.0.0\nfact npm left-pad 1.3.0\n", "bad_github_repo"],
    ["open https://example.com\nfact npm left-pad 1.3.0\n", "bad_line"],
  ];
  for (const [spec, code] of samples) {
    const parsed = tryParseManifest(spec);
    assert.equal(parsed.ok, false, spec);
    assert.equal(parsed.error, code);
  }
});

test("links stay on the three registry hosts", () => {
  assert.equal(safeHttpsHref(NPM_URL), NPM_URL);
  assert.equal(safeHttpsHref("https://example.com/left-pad"), "");
  assert.equal(safeHttpsHref("javascript:alert(1)"), "");
});
