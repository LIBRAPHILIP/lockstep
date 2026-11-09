# Lockstep — submission notes

**Category:** Workflow Automation

**Title:** Lockstep

## What it does

Lockstep is a sealed workflow runner. A sponsor deposits GEN against an ordered manifest of registry facts and named signatures. The manifest is frozen at funding. Validators re-fetch npm, PyPI, or a GitHub release before a fact gate can close. The payee is paid only when every gate is closed. If the deadline passes with a gate open, the sponsor is refunded. Both parties can consent to unwind early.

## The problem it solves

Release payments are usually a checklist in a tool the payer controls. That person can edit a step or mark it done. The payee has to trust the operator. Lockstep is the version of that checklist where the steps cannot be edited after the deposit, and a public registry is read by the GenLayer validators rather than by the operator.

The contract does not call a model. It does not accept a sponsor-supplied URL. A signature cannot skip a registry gate that is still open.

## How to use it

1. Open the live app (or `npm run dev` in this repo).
2. Connect a wallet or create an ephemeral Studionet account. Fund it.
3. Bind the contract below, or deploy `contracts/lockstep.py`.
4. Choose a template, preview the manifest, and fund at least 0.01 GEN.
5. Advance each fact gate, attest when you are the named signer, then settle. Use refund only after the deadline if a gate is still open.

The transaction panel waits for an accepted receipt, shows validator votes, links the explorer, and reloads the run from the contract before a lamp changes. Appeal and finalize appear when the chain says the transaction can take that step.

## Evidence

| | |
| --- | --- |
| GitHub | https://github.com/LIBRAPHILIP/lockstep |
| Live app | https://lockstep-psi.vercel.app |
| Network | Studionet, chain 61999 |
| Contract | `0xFd5e6A673453FB63016BFCC24c614A482537B338` |
| Deploy tx | `0xcbe473dcd573f69cb6c0d4349faa9df0feeb60dc7cb4e311f71d9ecebb8ab479` |
| Explorer | https://explorer-studio.genlayer.com/address/0xFd5e6A673453FB63016BFCC24c614A482537B338 |
| Version | `1.0.0-lockstep` |
| LLM | not used (`llm_rule=none`) |

Live run 0 on that contract: fact gate closed on npm `left-pad` `1.3.0` (`name_version_match`), then attest, then `PAID` / `all_gates_closed` / escrow 0.

| Step | Transaction |
| --- | --- |
| fund_run | `0x977a9dfe67c16b07073029297da7bc4ca43774d8d6967cce79b7d2fa76c382d3` |
| advance | `0x4eaefe9b5825c5850e6963ebb1629101010c90fd594e5139e35c28a095b80c0c` |
| attest | `0x996133f4515ef0288e8a8a81c0af2ef299918b305c067173a667f64315999d4a` |
| settle | `0x2fd509b5a6c3f9636aa8a89fd4d43bcaec24633643fe895c1845ad71b286593e` |

Primary tag: **Workflow Automation**.

Happy-path evidence, once `npm run demo:studionet` has run, is `deployments/live-check.json`: a left-pad 1.3.0 fact gate closed with outcome `match`, then attest, then `PAID`.
