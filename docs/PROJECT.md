# Lockstep

Lockstep is a workflow runner. A sponsor deposits GEN against an ordered manifest. The manifest is frozen by that deposit. Gates then close one at a time, and the deposit moves only at the end.

## The trust problem

Teams already automate "when the release is actually out, pay the person." The checklist lives in a tracker, a Zap, or a chat message. The person who owns that tool can edit a step, replay a webhook, or tick the box. The payee cannot prove the run followed the gates they agreed to. When the last step moves money, the operator is the clerk and the judge.

A better summary of the checklist does not fix that. The checklist has to be immutable after the deposit, and a fact about the world has to be re-read by validators who do not work for the operator.

## What a run is

A run has two or more gates, at most five, and at least one fact gate.

- **Fact.** The contract builds an HTTPS URL itself. Authorities are the npm registry, PyPI, and the GitHub Releases API. Validators fetch that URL and compare a small decision record. The gate closes only on a match: the pinned version is the published name and version, or the GitHub tag is published and not a draft. A yanked PyPI release is not a match. An unreadable response is not a match and is not a refund.
- **Attest.** The named account sends a transaction. That records a signature. It does not claim the registry said anything.

Gates close in order. The next open gate is the only one a transaction can close. A signature cannot jump ahead of a registry read.

## How money moves

- **Settle** pays the payee the full deposit after every gate is closed. This still works after the deadline. A finished manifest is not clawed back because nobody clicked in time.
- **Refund** pays the sponsor after the deadline if any gate is still open.
- **Unwind** pays the sponsor when both the sponsor and the payee have consented. One signature is not enough, unless both roles are the same account.

No method edits, reorders, or deletes a gate. The sponsor does not supply a URL.

## What this is for

The first workflows are release checklists:

1. Pay when `left-pad@1.3.0` is on npm and the maintainer signs.
2. Pay when two pinned artifacts are on their public registries, with no signature in between.
3. Pay when GitHub shows a release tag is published and not a draft, then the signer accepts.

A studio can keep using the same contract for the next package version. The grammar is the product: add a fact line, name the signer, fund it. A later caller, including a cron that only submits `advance`, can push the next registry read. That caller cannot mark the gate closed. Continued use looks like more authorities on the same gate machine, not a new promise in a chat.

## What this does not do

The contract does not accept an arbitrary URL. It does not decide code quality. It does not call a model. It does not pay a partial amount for a partial checklist. GitHub may rate-limit a fetch; that leaves the gate open until a later advance agrees on a match, or until the deadline refunds the sponsor.
