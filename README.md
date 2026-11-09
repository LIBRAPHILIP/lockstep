# Lockstep

Sealed workflow automation on [GenLayer](https://genlayer.com). A sponsor funds an ordered release checklist. The checklist cannot be edited after the deposit. GEN moves to the payee only when every gate has closed, or back to the sponsor if the deadline passes with a gate still open.

Fact gates are not checkboxes. Validators re-fetch a URL the contract builds for npm, PyPI, or a GitHub release. Attest gates are signatures by a named account. The LLM is not used.

## Live

App: [https://lockstep-psi.vercel.app](https://lockstep-psi.vercel.app). Studionet contract `0xFd5e6A673453FB63016BFCC24c614A482537B338` ([explorer](https://explorer-studio.genlayer.com/address/0xFd5e6A673453FB63016BFCC24c614A482537B338)). Run 0 is `PAID`: validators matched npm `left-pad` `1.3.0`, the signer attested, and settle moved the deposit. Transactions are in [SUBMISSION.md](SUBMISSION.md).

## Run it

```bash
npm install
npm test
npm run test:py
npm run dev
```

Open the Vite URL. The app defaults to Studionet (chain 61999).

1. Create an ephemeral account, or connect a wallet.
2. Bind the deployed contract, or deploy this source from the page.
3. Pick a template. Put your account on the attest line.
4. Preview. Funding asks the contract to parse the manifest and stops if that parse disagrees with the form.
5. Fund. The desk reloads the run from the contract. The manifest plate is the stored spec.
6. Advance the fact gate and wait for the accepted receipt. The lamp turns only after the reload shows the gate closed.
7. Attest, then settle. Refund and unwind are the other ways the deposit can move.

`npm run deploy:studionet` deploys with a new key unless `PRIVATE_KEY` is set. The key is written to `deploy/deployer.local.json` and is gitignored. `npm run verify:live` checks `get_meta` and `preview_manifest`. `npm run demo:studionet` funds a left-pad run and settles it.

## Contract

`contracts/lockstep.py`

| Method | What it does |
| --- | --- |
| `fund_run` | Payable. Freezes the manifest and holds the deposit. |
| `advance` | Fetches the next fact gate. Closes it only on a match. |
| `attest` | The named signer closes the next attest gate. |
| `settle` | Pays the payee when every gate is closed. |
| `refund` | Pays the sponsor after the deadline if a gate is open. |
| `consent_unwind`, `unwind` | Both parties agree to return the deposit early. |
| `preview_manifest` | Shows the URLs the contract will fetch. No write. |

Reads: `get_meta`, `describe`, `get_run`, `list_runs`, `get_run_count`.

## Docs

- [What it is](docs/PROJECT.md)
- [How a fact gate reaches consensus](docs/CONSENSUS.md)
- [Click path](HOW_TO_DEMO.md)
- [Submission notes](SUBMISSION.md)
