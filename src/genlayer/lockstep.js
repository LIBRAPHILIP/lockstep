/**
 * Lockstep reads and writes. Every write waits for an accepted receipt
 * and polls validator rounds while it waits.
 */
import { TransactionStatus } from "genlayer-js/types";
import contractSource from "../../contracts/lockstep.py?raw";
import {
  getReadClient,
  getWriteClient,
  initializeConsensus,
  getActiveNetworkKey,
} from "./client.js";
import { getNetwork } from "./networks.js";

export { contractSource };

const ADDRESS_KEY = "lockstep.contract";

export function loadSavedAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) || "";
  } catch {
    return "";
  }
}

export function saveAddress(address) {
  try {
    if (address) localStorage.setItem(ADDRESS_KEY, address);
    else localStorage.removeItem(ADDRESS_KEY);
  } catch {
    /* private mode */
  }
}

function requireAddress(address) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Set the Lockstep contract address first.");
  }
  return address;
}

export function parseMaybeJson(value) {
  if (value == null) return value;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function extractContractAddress(receipt) {
  return (
    receipt?.data?.contract_address ||
    receipt?.to_address ||
    receipt?.txDataDecoded?.contractAddress ||
    receipt?.contractAddress ||
    receipt?.data?.contractAddress ||
    null
  );
}

function executionRows(receipt) {
  const rows = [];
  const data = receipt?.consensus_data;
  const leaders = data?.leader_receipt || [];
  for (const row of Array.isArray(leaders) ? leaders : [leaders]) {
    if (row) rows.push(row);
  }
  for (const row of data?.validators || []) rows.push(row);
  if (receipt?.genvm_result) {
    rows.push({
      execution_result: receipt.genvm_result.execution_result,
      vote: "agree",
      genvm_result: receipt.genvm_result,
    });
  }
  return rows;
}

export function executionError(receipt) {
  const rows = executionRows(receipt);
  let success = false;
  let stderr = "";
  for (const row of rows) {
    if (String(row?.execution_result || "").toUpperCase() === "SUCCESS") success = true;
    const text = String(row?.genvm_result?.stderr || "").trim();
    if (!text || /cancelled after quorum/i.test(text)) continue;
    if (String(row?.vote || "") === "idle") continue;
    if (!stderr) stderr = text;
  }
  if (!stderr || success) return "";
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-4).join(" ");
}

export function receiptLooksFailed(receipt) {
  if (executionError(receipt)) return true;
  const status = String(receipt?.statusName || receipt?.status || "").toUpperCase();
  const result = String(
    receipt?.result_name || receipt?.resultName || receipt?.txExecutionResultName || ""
  ).toUpperCase();
  if (status.includes("REJECT") || status.includes("ERROR") || status.includes("UNDETERMINED")) return true;
  if (result.includes("ERROR") || result.includes("REVERT") || result.includes("REJECT")) return true;
  return false;
}

async function writeMethod(address, functionName, args, { onProgress, value = 0n, label } = {}) {
  const client = getWriteClient();
  await initializeConsensus();
  onProgress?.({ phase: "submitting", message: `Submitting ${label || functionName}…` });
  const tx = { address: requireAddress(address), functionName, args };
  if (value && value !== 0n) tx.value = value;
  const txHash = await client.writeContract(tx);
  onProgress?.({
    phase: "consensus",
    message: "Transaction is in flight. Validators are working the round.",
    txHash,
  });
  const receipt = await waitWithConsensus(txHash, {
    onRound: (info) => onProgress?.({ phase: "consensus", ...info, txHash }),
  });
  if (receiptLooksFailed(receipt)) {
    const detail = executionError(receipt) || receipt?.statusName || receipt?.result_name || "execution failed";
    throw new Error(`${label || functionName} reverted: ${detail}`);
  }
  onProgress?.({ phase: "accepted", message: `${label || functionName} accepted. Reloading the run from the contract.`, txHash, receipt });
  return { txHash, receipt };
}

export function deployLockstep({ onProgress } = {}) {
  return (async () => {
    const client = getWriteClient();
    await initializeConsensus();
    onProgress?.({ phase: "submitting", message: "Submitting Lockstep deployContract…" });
    const txHash = await client.deployContract({ code: contractSource, args: [] });
    onProgress?.({ phase: "consensus", message: "Waiting for the deploy to be accepted…", txHash });
    const receipt = await waitWithConsensus(txHash, {
      onRound: (info) => onProgress?.({ phase: "consensus", ...info, txHash }),
    });
    const address = extractContractAddress(receipt);
    if (!address) throw new Error("Deploy was accepted but the receipt has no contract address.");
    saveAddress(address);
    onProgress?.({ phase: "accepted", message: "Lockstep deployed", txHash, address, receipt });
    return { address, txHash, receipt };
  })();
}

export function fundRun(address, fields, opts) {
  return writeMethod(
    address,
    "fund_run",
    [fields.title, fields.note || "", fields.payee, String(fields.deadlineSecs), fields.spec],
    { ...opts, value: fields.valueWei, label: "fund_run" }
  );
}

export function advanceRun(address, runId, opts) {
  return writeMethod(address, "advance", [String(runId)], { ...opts, label: "advance" });
}

export function attestRun(address, runId, remark, opts) {
  return writeMethod(address, "attest", [String(runId), remark || ""], { ...opts, label: "attest" });
}

export function settleRun(address, runId, opts) {
  return writeMethod(address, "settle", [String(runId)], { ...opts, label: "settle" });
}

export function refundRun(address, runId, opts) {
  return writeMethod(address, "refund", [String(runId)], { ...opts, label: "refund" });
}

export function consentUnwind(address, runId, opts) {
  return writeMethod(address, "consent_unwind", [String(runId)], { ...opts, label: "consent_unwind" });
}

export function unwindRun(address, runId, opts) {
  return writeMethod(address, "unwind", [String(runId)], { ...opts, label: "unwind" });
}

export async function appealRun(txHash, { onProgress } = {}) {
  const client = getWriteClient();
  await initializeConsensus();
  onProgress?.({ phase: "submitting", message: "Submitting an appeal on this transaction…", txHash });
  await client.appealTransaction({ txId: txHash });
  onProgress?.({ phase: "consensus", message: "Appeal is in a new consensus round.", txHash });
  const receipt = await waitWithConsensus(txHash, {
    onRound: (info) => onProgress?.({ phase: "consensus", ...info, txHash }),
  });
  onProgress?.({ phase: "accepted", message: "Appeal round accepted.", txHash, receipt });
  return { txHash, receipt };
}

export async function finalizeRun(txHash, { onProgress } = {}) {
  const client = getWriteClient();
  await initializeConsensus();
  onProgress?.({ phase: "submitting", message: "Submitting finalize…", txHash });
  const evmHash = await client.finalizeTransaction({ txId: txHash });
  onProgress?.({ phase: "finality", message: "Finalize submitted. Checking the transaction status.", txHash, evmHash });
  return { txHash, evmHash };
}

export async function readMeta(address) {
  return getReadClient().readContract({
    address: requireAddress(address),
    functionName: "get_meta",
    args: [],
  });
}

export async function readRun(address, runId) {
  const raw = await getReadClient().readContract({
    address: requireAddress(address),
    functionName: "get_run",
    args: [String(runId)],
  });
  return parseMaybeJson(raw);
}

export async function readRuns(address) {
  const client = getReadClient();
  const contract = requireAddress(address);
  const rawCount = await client.readContract({
    address: contract,
    functionName: "get_run_count",
    args: [],
  });
  const total = Number(rawCount ?? 0);
  if (!Number.isFinite(total) || total <= 0) return [];
  const raw = await client.readContract({
    address: contract,
    functionName: "list_runs",
    args: [0n, 12n],
  });
  let value = parseMaybeJson(raw);
  if (typeof value === "string") value = parseMaybeJson(value);
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.map(parseMaybeJson).filter((row) => row && !row.error && row.run_id != null);
}

export async function previewManifest(address, spec) {
  const raw = await getReadClient().readContract({
    address: requireAddress(address),
    functionName: "preview_manifest",
    args: [spec],
  });
  return parseMaybeJson(raw);
}

export async function waitWithConsensus(txHash, { onRound } = {}) {
  const client = getReadClient();
  let stopped = false;
  const poll = (async () => {
    let ticks = 0;
    while (!stopped && ticks < 240) {
      ticks += 1;
      try {
        onRound?.(await fetchConsensusSnapshot(txHash));
      } catch {
        /* round data appears after the tx is known */
      }
      await sleep(2500);
    }
  })();
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      status: TransactionStatus.ACCEPTED,
      retries: 360,
      interval: 5000,
      fullTransaction: true,
    });
    try {
      onRound?.({ ...(await fetchConsensusSnapshot(txHash)), terminal: true, receiptStatus: receipt.statusName });
    } catch {
      /* snapshot is optional once the receipt exists */
    }
    try {
      const tx = await client.getTransaction({ hash: txHash });
      if (tx && typeof tx === "object") return { ...receipt, ...tx, statusName: tx.statusName || receipt.statusName };
    } catch {
      /* the receipt still carries the accepted status */
    }
    return receipt;
  } finally {
    stopped = true;
    await poll.catch(() => {});
  }
}

export async function fetchConsensusSnapshot(txHash) {
  const client = getReadClient();
  const snapshot = {
    txHash,
    network: getActiveNetworkKey(),
    at: new Date().toISOString(),
    transaction: null,
    lastRound: null,
    canAppeal: null,
    rawErrors: [],
  };
  try {
    if (typeof client.getTransaction === "function") {
      snapshot.transaction = await client.getTransaction({ hash: txHash });
    }
  } catch (error) {
    snapshot.rawErrors.push(`getTransaction: ${error.message}`);
  }
  try {
    if (typeof client.getLastRoundData === "function") {
      snapshot.lastRound = await client.getLastRoundData({ txId: txHash });
    }
  } catch (error) {
    snapshot.rawErrors.push(`getLastRoundData: ${error.message}`);
  }
  try {
    if (typeof client.canAppeal === "function") {
      snapshot.canAppeal = await client.canAppeal({ txId: txHash });
    }
  } catch (error) {
    snapshot.rawErrors.push(`canAppeal: ${error.message}`);
  }
  return snapshot;
}

export function summarizeConsensus(snapshot) {
  if (!snapshot) return [];
  const details = [];
  const tx = snapshot.transaction;
  if (tx) {
    details.push(["Tx status", String(tx.statusName || tx.status || "pending")]);
    const resultName = tx.result_name || tx.resultName;
    if (resultName) details.push(["Result", String(resultName)]);
    const votes = tx.consensus_data?.votes;
    if (votes && typeof votes === "object") {
      const entries = Object.entries(votes);
      if (entries.length) {
        details.push(["Validators", String(entries.length)]);
        details.push(["Votes", entries.map(([addr, vote]) => `${String(addr).slice(0, 6)}:${vote}`).join(" · ")]);
      }
    }
    if (tx.num_of_rounds != null) details.push(["Rounds", String(tx.num_of_rounds)]);
  }
  const round = snapshot.lastRound?.round ?? snapshot.lastRound?.roundData?.round;
  if (round != null) details.push(["Consensus round", String(round)]);
  if (snapshot.canAppeal != null) details.push(["Appealable", snapshot.canAppeal ? "yes" : "no"]);
  if (snapshot.receiptStatus) details.push(["Receipt", String(snapshot.receiptStatus)]);
  return details;
}

export function statusNameOf(snapshot) {
  const tx = snapshot?.transaction;
  return String(tx?.statusName || tx?.status || snapshot?.receiptStatus || "").toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
