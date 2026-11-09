/**
 * Fund a real npm release run, advance it, attest, and settle.
 * Uses the deployer key written by scripts/deploy.mjs. The key stays local.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployed = JSON.parse(readFileSync(path.join(root, "src", "deployed.json"), "utf8"));
const signer = JSON.parse(readFileSync(path.join(root, "deploy", "deployer.local.json"), "utf8"));

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function wait(client, hash, label) {
  console.log(label, hash);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: 400,
    interval: 5000,
    fullTransaction: true,
  });
  const status = String(receipt.statusName || receipt.status || "");
  const result = String(receipt.result_name || receipt.resultName || receipt.txExecutionResultName || "");
  console.log("  status:", status, result);
  if (/REJECT|ERROR|UNDETERMINED|REVERT/i.test(status + result)) {
    throw new Error(label + " failed: " + status + " " + result);
  }
  return receipt;
}

async function main() {
  if (!deployed.address) throw new Error("Deploy Lockstep first");
  const account = createAccount(signer.privateKey);
  const client = createClient({ chain: studionet, account });
  await client.initializeConsensusSmartContract();
  const spec = `fact npm left-pad 1.3.0\nattest ${account.address}`;
  console.log("Funding", spec.replaceAll("\n", " | "));
  const fundHash = await client.writeContract({
    address: deployed.address,
    functionName: "fund_run",
    args: ["Ship left-pad 1.3.0", "Demo: pay when npm shows left-pad 1.3.0 and the signer attests.", account.address, "86400", spec],
    value: 2n * 10n ** 16n,
  });
  await wait(client, fundHash, "fund_run");
  const count = Number(await client.readContract({ address: deployed.address, functionName: "get_run_count", args: [] }));
  const runId = String(count - 1);
  console.log("run", runId);

  const advanceHash = await client.writeContract({
    address: deployed.address,
    functionName: "advance",
    args: [runId],
  });
  await wait(client, advanceHash, "advance");
  let run = asObject(await client.readContract({ address: deployed.address, functionName: "get_run", args: [runId] }));
  const fact = run.gates?.[0];
  console.log("fact gate", fact?.state, fact?.outcome, fact?.reason, fact?.observed_name, fact?.observed_version);
  if (fact?.state !== "closed" || fact?.outcome !== "match" || fact?.observed_version !== "1.3.0") {
    throw new Error("npm gate did not close on left-pad 1.3.0: " + JSON.stringify(fact));
  }

  const attestHash = await client.writeContract({
    address: deployed.address,
    functionName: "attest",
    args: [runId, "registry matches the pin"],
  });
  await wait(client, attestHash, "attest");

  const settleHash = await client.writeContract({
    address: deployed.address,
    functionName: "settle",
    args: [runId],
  });
  await wait(client, settleHash, "settle");
  run = asObject(await client.readContract({ address: deployed.address, functionName: "get_run", args: [runId] }));
  console.log("final", run.status, run.settlement_basis, run.escrow_wei);
  if (run.status !== "PAID" || run.escrow_wei !== "0" || run.settlement_basis !== "all_gates_closed") {
    throw new Error("settle did not pay: " + JSON.stringify({ status: run.status, basis: run.settlement_basis, escrow: run.escrow_wei }));
  }
  const evidence = {
    address: deployed.address,
    runId,
    status: run.status,
    settlement_basis: run.settlement_basis,
    escrow_wei: run.escrow_wei,
    fact: {
      source: fact.source,
      outcome: fact.outcome,
      reason: fact.reason,
      observed_name: fact.observed_name,
      observed_version: fact.observed_version,
    },
    txs: { fund: fundHash, advance: advanceHash, attest: attestHash, settle: settleHash },
    checkedAt: new Date().toISOString(),
  };
  mkdirSync(path.join(root, "deployments"), { recursive: true });
  writeFileSync(path.join(root, "deployments", "live-check.json"), JSON.stringify(evidence, null, 2));
  console.log("Wrote deployments/live-check.json");
}

main().catch((error) => {
  console.error("Demo run failed:", error);
  process.exit(1);
});
