# Consensus

`advance` is the only method that reads the network. It calls `gl.vm.run_nondet_unsafe`.

The leader fetches the URL stored on the next fact gate. That URL was built at funding from `source_url` and the pinned authority, package, and version. The leader returns eight strings: authority, package, version, source, outcome, reason, observed name, and observed version. The page body is not returned and is not stored.

The validator fetches the same URL and accepts the leader only when those eight strings match its own record and `fact_acceptable` holds. Outcomes are `match`, `absent`, `mismatch`, and `unreadable`. A match is only `name_version_match` (npm or PyPI) or `tag_published` (GitHub, and only when `draft` is not true). HTTP 404 is `absent`. Any other HTTP failure, a non-JSON body, a rate-limit message, or a body over the cap is `unreadable`. Validators that both see an error agree on `http_error` without comparing the status code, so a 429 and a 503 can still agree that the source was unreadable.

If the validators disagree, the transaction does not write. The gate stays as it was. The caller retries.

If they agree on a match, the gate closes. If they agree on anything else, the gate stays open and the agreed outcome is stored so the desk can show it. Agreement that the source is down is not a reason to pay or to refund early.

`fund_run`, `attest`, `settle`, `refund`, `consent_unwind`, and `unwind` do not fetch and do not call a model. `time.time` in those methods is the transaction timestamp, so a gate submitted before the deadline is judged on that timestamp.

`get_meta.llm_rule` is `none`.
