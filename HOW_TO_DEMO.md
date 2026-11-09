# Demo path

Live app: https://lockstep-psi.vercel.app. Network: Studionet, chain 61999. Contract: `0xFd5e6A673453FB63016BFCC24c614A482537B338`. Run 0 on that contract is already `PAID`. Fund a new run to walk the path yourself. The address is also in `src/deployed.json`.

1. Open the app. The health pip should show Studionet.
2. Click **Ephemeral account**. The studio faucet funds it. The account line shows a GEN balance from `eth_getBalance`.
3. If the address field is empty, click **Deploy** and wait until the annunciator says the deploy was accepted. The desk reloads `get_meta`.
4. Click **Registry release**. Click **Put my account on attest gates**. The manifest should read `fact npm left-pad 1.3.0` and `attest 0x…` with your account.
5. Click **Ask the contract to preview**. The preview line must show `https://registry.npmjs.org/left-pad/1.3.0`.
6. Leave the deposit at `0.02` GEN and the deadline at 1 day. Click **Fund this manifest**. The annunciator moves Submitted → Consensus → Accepted, with the transaction link and validator votes when the round publishes them.
7. The new run appears from `list_runs`. The manifest plate says FROZEN. The fact lamp is red. There is no control that sets it green locally.
8. Click **Advance fact gate**. This is the slow step. Validators fetch npm. When the receipt is accepted, the desk reloads. The first lamp is green only if the stored outcome is `match` and the observed version is `1.3.0`.
9. Click **Attest**, then **Settle to payee**. The run status becomes `PAID`, escrow is `0`, and the basis is `all_gates_closed`.
10. Optional refund drill: fund a second run whose fact is `fact npm left-pad 9.9.9`, deadline 2 minutes, then advance. The gate stays open with `not_found`. After the deadline, **Refund sponsor** returns the deposit. Do not use that pin for the happy path.

The same sequence is `npm run demo:studionet` from the deployer account. It writes `deployments/live-check.json`.

Votes on screen come from `getTransaction` and `getLastRoundData`. Do not stage a closed gate that the contract does not return.
