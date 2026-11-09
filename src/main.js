import deployed from "./deployed.json";
import {
  setNetwork,
  useEphemeralAccount,
  connectInjectedWallet,
  fundStudioAccount,
  probeNetworkHealth,
  readBalance,
  getActiveNetworkKey,
  getActiveAccount,
  getWalletMode,
} from "./genlayer/client.js";
import { explorerAddressUrl, explorerTxUrl, getNetwork } from "./genlayer/networks.js";
import {
  loadSavedAddress,
  saveAddress,
  parseMaybeJson,
  deployLockstep,
  fundRun,
  advanceRun,
  attestRun,
  settleRun,
  refundRun,
  consentUnwind,
  unwindRun,
  appealRun,
  finalizeRun,
  readMeta,
  readRuns,
  previewManifest,
  fetchConsensusSnapshot,
  summarizeConsensus,
  statusNameOf,
} from "./genlayer/lockstep.js";
import {
  tryParseManifest,
  sameManifest,
  parseGenToWei,
  parseDeadline,
  formatGen,
  safeHttpsHref,
  isAddress,
  short,
  errorText,
  nextGate,
  allClosed,
  normalizeAddress,
} from "./genlayer/rules.js";

const $ = (id) => document.getElementById(id);

const TEMPLATES = [
  {
    id: "release",
    name: "Registry release",
    blurb: "npm shows left-pad 1.3.0, then the named account signs.",
    title: "Ship left-pad 1.3.0",
    note: "Pay the signer once the npm registry shows left-pad 1.3.0.",
    spec: "fact npm left-pad 1.3.0\nattest SIGNER",
  },
  {
    id: "dual",
    name: "Two registries",
    blurb: "left-pad is on npm and six 1.16.0 is on PyPI. No signature.",
    title: "Publish both artifacts",
    note: "Release only when both pinned artifacts are on their public registries.",
    spec: "fact npm left-pad 1.3.0\nfact pypi six 1.16.0",
  },
  {
    id: "github",
    name: "GitHub release",
    blurb: "Flask 3.0.0 is a published release, then the named account signs.",
    title: "Flask 3.0.0 is tagged",
    note: "Pay the signer after GitHub shows the Flask 3.0.0 release is not a draft.",
    spec: "fact github pallets/flask 3.0.0\nattest SIGNER",
  },
];

const state = {
  address: "",
  account: "",
  busy: false,
  meta: null,
  runs: [],
  health: null,
  balances: {},
  template: "release",
  life: {
    phase: "idle",
    message: "No transaction yet. Funding, advance, attest, settle, refund, and unwind each wait for an accepted receipt.",
    txHash: "",
    facts: [],
    canAppeal: false,
    canFinalize: false,
    error: false,
  },
};

function net() {
  return getNetwork(getActiveNetworkKey());
}

function accountAddress() {
  const account = getActiveAccount();
  if (!account) return "";
  return typeof account === "string" ? account : account.address || "";
}

function setLife(patch) {
  state.life = { ...state.life, ...patch };
  renderLife();
}

function renderLife() {
  const life = state.life;
  $("lifeMessage").textContent = life.message || "";
  const order = ["submitting", "consensus", "accepted", "finality"];
  const reached = life.error ? -1 : order.indexOf(life.phase);
  for (const node of $("lifeLamps").querySelectorAll("span")) {
    const phase = node.dataset.phase;
    const index = order.indexOf(phase);
    node.classList.toggle("on", !life.error && reached >= index && reached !== -1);
    node.classList.toggle("bad", Boolean(life.error) && phase === "consensus");
  }
  if (life.phase === "finality" && !life.error) {
    $("lifeLamps").querySelector('[data-phase="finality"]').classList.add("on");
  }
  const link = $("lifeTx");
  const href = explorerTxUrl(net(), life.txHash);
  if (href) {
    link.hidden = false;
    link.href = href;
    link.textContent = short(life.txHash);
  } else {
    link.hidden = true;
  }
  $("btnRefreshTx").hidden = !life.txHash;
  $("btnAppeal").hidden = !life.canAppeal || state.busy;
  $("btnFinalize").hidden = !life.canFinalize || state.busy;
  const facts = $("lifeFacts");
  facts.replaceChildren();
  for (const [label, value] of life.facts || []) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    facts.append(row);
  }
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["btnFund", "btnPreview", "btnDeploy", "btnBind", "btnFaucet", "btnEphemeral", "btnWallet"]) {
    $(id).disabled = busy;
  }
  renderLife();
}

function renderTemplates() {
  const host = $("templates");
  host.replaceChildren();
  for (const template of TEMPLATES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `template${state.template === template.id ? " is-on" : ""}`;
    const strong = document.createElement("strong");
    const span = document.createElement("span");
    strong.textContent = template.name;
    span.textContent = template.blurb;
    button.append(strong, span);
    button.addEventListener("click", () => applyTemplate(template.id));
    host.append(button);
  }
}

function signerOrToken() {
  return state.account && isAddress(state.account) ? state.account : "SIGNER";
}

function applyTemplate(id) {
  const template = TEMPLATES.find((item) => item.id === id) || TEMPLATES[0];
  state.template = template.id;
  $("title").value = template.title;
  $("note").value = template.note;
  $("spec").value = template.spec.replaceAll("SIGNER", signerOrToken());
  renderTemplates();
  renderLocalPreview();
}

function renderLocalPreview() {
  const parsed = tryParseManifest($("spec").value);
  const node = $("localPreview");
  if (!parsed.ok) {
    node.textContent = errorText(parsed.error);
    return;
  }
  const lines = parsed.gates.map((gate, index) => {
    if (gate.kind === "fact") return `${index + 1}. fact ${gate.authority} → ${gate.source}`;
    return `${index + 1}. attest ${gate.signer}`;
  });
  node.textContent = `Local parse · ${lines.join("  ·  ")}`;
}

function renderSession() {
  const mode = getWalletMode();
  const account = state.account ? `${short(state.account)} · ${mode}` : "No account yet.";
  const balance = state.balances[state.account];
  $("accountLine").textContent = balance != null ? `${account} · ${formatGen(balance)} GEN on this account` : account;
  $("contractAddress").value = state.address || "";
  const meta = state.meta;
  if (!state.address) {
    $("metaLine").textContent = "Bind a deployed Lockstep address, or deploy this source.";
  } else if (meta?.error) {
    $("metaLine").textContent = meta.error;
  } else if (meta) {
    const count = meta.run_count ?? meta.runCount ?? "0";
    $("metaLine").textContent = `${meta.title || "Lockstep"} ${meta.version || ""} · ${count} runs · ${meta.llm_rule === "none" ? "LLM not used" : "meta loaded"} · ${meta.order_rule || ""}`;
  }
  const pip = $("healthPip");
  const health = state.health;
  pip.classList.toggle("ok", Boolean(health?.ok));
  pip.classList.toggle("bad", Boolean(health && !health.ok));
  $("healthText").textContent = health
    ? `${health.label} · chain ${health.chainId}${health.ok ? ` · ${health.latencyMs} ms` : ` · ${health.error}`}`
    : "Checking the network";
}

function deadlineLabel(run) {
  const at = Number(run.deadline_at || 0);
  if (!at) return "";
  const left = at * 1000 - Date.now();
  const when = new Date(at * 1000).toLocaleString();
  if (left <= 0) return `Deadline passed · ${when}`;
  const hours = Math.floor(left / 3600000);
  const mins = Math.floor((left % 3600000) / 60000);
  return `Deadline in ${hours}h ${mins}m · ${when}`;
}

function gateNodes(run, activeId) {
  const list = document.createElement("ol");
  list.className = "track";
  const gates = Array.isArray(run.gates) ? run.gates : [];
  const current = nextGate(gates);
  gates.forEach((gate, index) => {
    const item = document.createElement("li");
    const closed = gate.state === "closed";
    const checking = state.busy && state.life.phase === "consensus" && run.run_id === activeId && gate === current;
    item.className = `gate${closed ? " is-closed" : ""}${checking ? " is-checking" : ""}`;
    const lamp = document.createElement("span");
    lamp.className = closed ? "lamp" : "lamp";
    if (!closed && gate !== current) lamp.classList.add("dim");
    const lever = document.createElement("span");
    lever.className = "lever";
    const kicker = document.createElement("span");
    kicker.className = "kicker";
    kicker.textContent = `${String(index + 1).padStart(2, "0")} · ${gate.kind === "fact" ? "Fact" : "Attest"}`;
    const title = document.createElement("strong");
    title.textContent = gate.kind === "fact" ? `${gate.authority} ${gate.pkg} ${gate.version}` : `Sign ${short(gate.signer)}`;
    const sub = document.createElement("span");
    sub.className = "sub";
    if (gate.kind === "fact") {
      const href = safeHttpsHref(gate.source);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = href;
        sub.append(link);
      } else {
        sub.textContent = "Source withheld. It is not one of the three registry hosts.";
      }
    } else {
      sub.textContent = closed ? `Signed${gate.remark ? ` · ${gate.remark}` : ""}` : "Waiting for this account.";
    }
    item.append(lamp, lever, kicker, title, sub);
    if (gate.outcome) {
      const outcome = document.createElement("span");
      outcome.className = "outcome";
      const seen = gate.observed_name ? ` · saw ${gate.observed_name}${gate.observed_version ? "@" + gate.observed_version : ""}` : "";
      outcome.textContent = `${gate.outcome}${gate.reason ? " · " + gate.reason : ""}${seen}`;
      item.append(outcome);
    }
    list.append(item);
  });

  const terminal = document.createElement("li");
  const paid = run.status === "PAID";
  const refunded = run.status === "REFUNDED" || run.status === "UNWOUND";
  const ready = run.status === "OPEN" && allClosed(gates);
  terminal.className = `gate${paid || ready ? " is-closed" : ""}`;
  const lamp = document.createElement("span");
  lamp.className = paid || ready ? "lamp" : "lamp dim";
  const lever = document.createElement("span");
  lever.className = "lever";
  const kicker = document.createElement("span");
  kicker.className = "kicker";
  kicker.textContent = "Terminal";
  const title = document.createElement("strong");
  title.textContent = paid ? "Paid the payee" : refunded ? run.status : ready ? "Ready to settle" : "GEN stays here";
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = "Not a gate. Settle, refund, and unwind are the only calls that move the deposit.";
  terminal.append(lamp, lever, kicker, title, sub);
  list.append(terminal);
  return list;
}

function actionButton(label, act, runId, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = act === "settle" || act === "advance" ? "solid" : "ghost";
  button.dataset.act = act;
  button.dataset.run = runId;
  button.textContent = label;
  button.disabled = disabled || state.busy;
  return button;
}

function renderDesk() {
  const host = $("runList");
  host.replaceChildren();
  if (!state.address) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Bind the Lockstep contract to load runs.";
    host.append(empty);
    return;
  }
  if (!state.runs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No runs on this contract yet. Fund a manifest and it will show up here, read back from the chain.";
    host.append(empty);
    return;
  }
  const me = (state.account || "").toLowerCase();
  for (const run of state.runs) {
    const card = document.createElement("article");
    card.className = "run";
    const head = document.createElement("div");
    head.className = "run-top";
    const titleWrap = document.createElement("div");
    const h3 = document.createElement("h3");
    h3.textContent = run.title || `Run ${run.run_id}`;
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = run.note || "";
    titleWrap.append(h3, note);
    const badges = document.createElement("div");
    const status = document.createElement("span");
    status.className = `status ${run.status || ""}`;
    status.textContent = run.status || "";
    const money = document.createElement("span");
    money.className = "money";
    money.textContent = `${formatGen(run.escrow_wei || 0)} GEN in escrow`;
    badges.append(status, money);
    head.append(titleWrap, badges);

    const parties = document.createElement("div");
    parties.className = "parties";
    parties.append(partyLink("Sponsor", run.sponsor), partyLink("Payee", run.payee));
    const clock = document.createElement("span");
    clock.textContent = deadlineLabel(run);
    parties.append(clock);
    if (run.settlement_basis) {
      const basis = document.createElement("span");
      basis.textContent = run.settlement_basis;
      parties.append(basis);
    }

    const frozen = document.createElement("div");
    frozen.className = "frozen";
    const stamp = document.createElement("span");
    stamp.className = "stamp";
    stamp.textContent = "FROZEN";
    const cap = document.createElement("span");
    cap.className = "kicker";
    cap.textContent = "Manifest stored at funding";
    const pre = document.createElement("pre");
    pre.textContent = run.spec || "";
    frozen.append(stamp, cap, pre);

    const actions = document.createElement("div");
    actions.className = "run-actions";
    const open = run.status === "OPEN";
    const nxt = nextGate(run.gates);
    if (open && nxt?.kind === "fact") actions.append(actionButton("Advance fact gate", "advance", run.run_id));
    if (open && nxt?.kind === "attest") {
      actions.append(actionButton("Attest", "attest", run.run_id, me !== String(nxt.signer || "").toLowerCase()));
    }
    if (open && allClosed(run.gates)) actions.append(actionButton("Settle to payee", "settle", run.run_id));
    if (open && !allClosed(run.gates)) actions.append(actionButton("Refund sponsor", "refund", run.run_id));
    if (open && (me === String(run.sponsor || "").toLowerCase() || me === String(run.payee || "").toLowerCase())) {
      actions.append(actionButton("Consent to unwind", "consent", run.run_id));
    }
    if (open) actions.append(actionButton("Unwind", "unwind", run.run_id, run.sponsor_unwind !== "1" || run.payee_unwind !== "1"));
    card.append(head, parties, gateNodes(run, state.life.runId), frozen, actions);
    host.append(card);
  }
}

function partyLink(label, address) {
  const span = document.createElement("span");
  span.textContent = `${label} `;
  const href = explorerAddressUrl(net(), address);
  if (href && isAddress(address)) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = short(address);
    span.append(link);
  } else {
    span.append(document.createTextNode(short(address)));
  }
  return span;
}

async function refreshBalances() {
  const targets = new Set();
  if (state.account) targets.add(state.account);
  for (const run of state.runs) {
    if (run.sponsor) targets.add(run.sponsor);
    if (run.payee) targets.add(run.payee);
  }
  await Promise.all(
    [...targets].slice(0, 8).map(async (address) => {
      try {
        state.balances[address] = await readBalance(address);
      } catch {
        /* balance is a display aid */
      }
    })
  );
}

async function refresh() {
  renderSession();
  if (!state.address || !isAddress(state.address)) {
    state.runs = [];
    renderDesk();
    return;
  }
  try {
    state.meta = parseMaybeJson(await readMeta(state.address));
    state.runs = await readRuns(state.address);
  } catch (error) {
    state.meta = { error: errorText(error) };
    state.runs = [];
  }
  await refreshBalances();
  renderSession();
  renderDesk();
}

async function refreshHealth() {
  state.health = await probeNetworkHealth();
  renderSession();
}

function onProgress(patch) {
  const facts = patch.transaction || patch.lastRound || patch.terminal ? summarizeConsensus(patch) : state.life.facts;
  const status = statusNameOf(patch);
  setLife({
    phase: patch.phase || state.life.phase,
    message: patch.message || state.life.message,
    txHash: patch.txHash || state.life.txHash,
    facts: facts || [],
    canAppeal: Boolean(patch.canAppeal),
    canFinalize: status.includes("READY_TO_FINALIZE"),
    error: false,
    runId: patch.runId || state.life.runId,
  });
}

async function afterWrite(runId) {
  await refresh();
  const run = state.runs.find((item) => String(item.run_id) === String(runId));
  if (!run) return;
  const nxt = nextGate(run.gates);
  const detail = nxt
    ? `Next open gate: ${nxt.kind}${nxt.reason ? `, last read ${nxt.reason}` : ""}.`
    : `No open gates. Status ${run.status}. Escrow ${formatGen(run.escrow_wei)} GEN.`;
  setLife({
    phase: "accepted",
    message: `${state.life.message} ${detail}`,
    runId: String(runId),
  });
}

async function handleDesk(event) {
  const button = event.target.closest("[data-act]");
  if (!button || state.busy) return;
  const act = button.dataset.act;
  const runId = button.dataset.run;
  setBusy(true);
  try {
    const opts = { onProgress: (patch) => onProgress({ ...patch, runId }) };
    if (act === "advance") await advanceRun(state.address, runId, opts);
    else if (act === "attest") await attestRun(state.address, runId, $("remark").value, opts);
    else if (act === "settle") await settleRun(state.address, runId, opts);
    else if (act === "refund") await refundRun(state.address, runId, opts);
    else if (act === "consent") await consentUnwind(state.address, runId, opts);
    else if (act === "unwind") await unwindRun(state.address, runId, opts);
    else return;
    await afterWrite(runId);
  } catch (error) {
    setLife({ phase: "consensus", error: true, message: errorText(error) });
  } finally {
    setBusy(false);
    renderDesk();
  }
}

async function onFund(event) {
  event.preventDefault();
  if (state.busy) return;
  const parsed = tryParseManifest($("spec").value);
  if (!parsed.ok) {
    setLife({ phase: "idle", error: true, message: errorText(parsed.error) });
    return;
  }
  if (!isAddress($("payee").value)) {
    setLife({ phase: "idle", error: true, message: errorText("bad_address") });
    return;
  }
  let valueWei;
  let deadlineSecs;
  try {
    valueWei = parseGenToWei($("amount").value);
    deadlineSecs = parseDeadline($("deadline").value);
  } catch (error) {
    setLife({ phase: "idle", error: true, message: errorText(error) });
    return;
  }
  setBusy(true);
  try {
    setLife({ phase: "submitting", error: false, message: "Asking the contract to preview the manifest before any GEN moves." });
    const remote = await previewManifest(state.address, $("spec").value);
    if (remote?.error || !sameManifest(parsed.gates, remote?.gates)) {
      throw new Error(remote?.error || "manifest_mismatch");
    }
    $("chainPreview").textContent = `Contract preview matches. Frozen spec will be: ${remote.spec}`;
    await fundRun(
      state.address,
      {
        title: $("title").value,
        note: $("note").value,
        payee: normalizeAddress($("payee").value),
        deadlineSecs,
        spec: $("spec").value,
        valueWei,
      },
      { onProgress }
    );
    await refresh();
    const newest = state.runs[0];
    setLife({
      phase: "accepted",
      message: newest
        ? `fund_run accepted. Run ${newest.run_id} is ${newest.status} with ${formatGen(newest.escrow_wei)} GEN. The manifest on the desk is the one stored in the contract.`
        : "fund_run accepted. Reloaded the desk.",
    });
  } catch (error) {
    setLife({ phase: "consensus", error: true, message: errorText(error) });
  } finally {
    setBusy(false);
    renderDesk();
  }
}

async function onPreview() {
  const parsed = tryParseManifest($("spec").value);
  renderLocalPreview();
  if (!parsed.ok) return;
  if (!state.address) {
    $("chainPreview").textContent = "Bind a contract to compare this draft with preview_manifest.";
    return;
  }
  setBusy(true);
  try {
    const remote = await previewManifest(state.address, $("spec").value);
    if (remote?.error) {
      $("chainPreview").textContent = errorText(remote.error);
      return;
    }
    const match = sameManifest(parsed.gates, remote.gates);
    $("chainPreview").textContent = match
      ? `Contract agrees. ${remote.gates.map((gate) => gate.source || gate.signer).join(" · ")}`
      : "The contract parsed a different manifest. Funding will refuse this draft.";
  } catch (error) {
    $("chainPreview").textContent = errorText(error);
  } finally {
    setBusy(false);
  }
}

function useMyAccount() {
  if (!state.account || !isAddress(state.account)) {
    setLife({ phase: "idle", error: true, message: "Create an ephemeral account or connect a wallet first." });
    return;
  }
  const parsed = tryParseManifest($("spec").value.replaceAll("SIGNER", state.account));
  if ($("spec").value.includes("SIGNER") || $("spec").value.includes("attest 0x\n") || $("spec").value.trim().endsWith("attest 0x")) {
    $("spec").value = $("spec").value.replaceAll("SIGNER", state.account).replace(/attest\s+0x\s*$/i, `attest ${state.account}`);
  } else if (parsed.ok) {
    $("spec").value = parsed.gates
      .map((gate) => (gate.kind === "attest" ? `attest ${state.account}` : `fact ${gate.authority} ${gate.pkg} ${gate.version}`))
      .join("\n");
  } else {
    $("spec").value = $("spec").value.replaceAll("SIGNER", state.account);
  }
  if (!$("payee").value || !isAddress($("payee").value)) $("payee").value = state.account;
  renderLocalPreview();
}

async function connect(kind) {
  setBusy(true);
  try {
    const session = kind === "wallet" ? await connectInjectedWallet() : useEphemeralAccount();
    state.account = session.address;
    if (kind === "ephemeral") {
      setLife({ phase: "submitting", error: false, message: "Requesting studio funds for the ephemeral account…" });
      await fundStudioAccount(session.address);
      setLife({ phase: "accepted", error: false, message: "Ephemeral account funded on this studio network. It can sign the next transaction." });
    }
    const draft = $("spec").value;
    if (draft.includes("SIGNER") || draft.trim().endsWith("attest 0x")) useMyAccount();
    else if (!$("payee").value || !isAddress($("payee").value)) $("payee").value = state.account;
    await refresh();
  } catch (error) {
    setLife({ phase: "idle", error: true, message: errorText(error) });
  } finally {
    setBusy(false);
  }
}

async function onDeploy() {
  setBusy(true);
  try {
    const result = await deployLockstep({ onProgress });
    state.address = result.address;
    saveAddress(result.address);
    setLife({
      phase: "accepted",
      message: `Deploy accepted. Lockstep is at ${result.address}.`,
      txHash: result.txHash,
    });
    await refresh();
  } catch (error) {
    setLife({ phase: "consensus", error: true, message: errorText(error) });
  } finally {
    setBusy(false);
  }
}

async function onFaucet() {
  if (!state.account) return;
  setBusy(true);
  try {
    await fundStudioAccount(state.account);
    await refresh();
    setLife({ phase: "accepted", error: false, message: "Studio faucet request returned. Balance reloaded from eth_getBalance." });
  } catch (error) {
    setLife({ phase: "idle", error: true, message: errorText(error) });
  } finally {
    setBusy(false);
  }
}

async function refreshTxStatus() {
  if (!state.life.txHash) return;
  const snapshot = await fetchConsensusSnapshot(state.life.txHash);
  const status = statusNameOf(snapshot);
  setLife({
    facts: summarizeConsensus(snapshot),
    canAppeal: Boolean(snapshot.canAppeal),
    canFinalize: status.includes("READY_TO_FINALIZE"),
    phase: status.includes("FINAL") ? "finality" : state.life.phase,
    message: status ? `Chain status ${status}.` : state.life.message,
    error: false,
  });
}

function startYard(canvas) {
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frameId = 0;
  let width = 0;
  let height = 0;
  let time = 0;
  let running = true;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (!running) return;
    time += reduce ? 0 : 0.008;
    ctx.clearRect(0, 0, width, height);
    const rail = height * 0.62;
    ctx.strokeStyle = "rgba(231,242,234,0.2)";
    ctx.lineWidth = 1.4;
    for (const offset of [-10, 10]) {
      ctx.beginPath();
      ctx.moveTo(0, rail + offset);
      ctx.lineTo(width, rail + offset);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(240,195,106,0.35)";
    for (let x = 12; x < width; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x, rail - 16);
      ctx.lineTo(x + 6, rail + 16);
      ctx.stroke();
    }
    const travel = reduce ? width * 0.5 : width * (0.12 + ((Math.sin(time) + 1) / 2) * 0.76);
    ctx.fillStyle = "#f0c36a";
    ctx.beginPath();
    ctx.arc(travel, rail, 6, 0, Math.PI * 2);
    ctx.fill();
    if (!reduce) frameId = requestAnimationFrame(draw);
  }

  resize();
  draw();
  window.addEventListener("resize", () => {
    resize();
    if (reduce) draw();
  });
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running && !reduce) draw();
    if (!running) cancelAnimationFrame(frameId);
  });
}

function boot() {
  const saved = loadSavedAddress();
  state.address = saved || deployed.address || "";
  if (deployed.network) $("networkSelect").value = deployed.network === "studionet" ? "studionet" : $("networkSelect").value;
  setNetwork($("networkSelect").value);
  renderTemplates();
  renderLocalPreview();
  renderLife();
  startYard($("yard"));
  $("spec").addEventListener("input", renderLocalPreview);
  $("networkSelect").addEventListener("change", async () => {
    setNetwork($("networkSelect").value);
    await refreshHealth();
    await refresh();
  });
  $("btnEphemeral").addEventListener("click", () => connect("ephemeral"));
  $("btnWallet").addEventListener("click", () => connect("wallet"));
  $("btnUseAccount").addEventListener("click", useMyAccount);
  $("btnPreview").addEventListener("click", onPreview);
  $("fundForm").addEventListener("submit", onFund);
  $("btnBind").addEventListener("click", async () => {
    const value = $("contractAddress").value.trim();
    if (!isAddress(value)) {
      setLife({ phase: "idle", error: true, message: errorText("bad_address") });
      return;
    }
    state.address = normalizeAddress(value);
    saveAddress(state.address);
    await refresh();
  });
  $("btnDeploy").addEventListener("click", onDeploy);
  $("btnFaucet").addEventListener("click", onFaucet);
  $("runList").addEventListener("click", handleDesk);
  $("btnRefreshTx").addEventListener("click", () => refreshTxStatus().catch((error) => setLife({ error: true, message: errorText(error) })));
  $("btnAppeal").addEventListener("click", async () => {
    if (!state.life.txHash || state.busy) return;
    setBusy(true);
    try {
      await appealRun(state.life.txHash, { onProgress });
      await refresh();
    } catch (error) {
      setLife({ phase: "consensus", error: true, message: errorText(error) });
    } finally {
      setBusy(false);
    }
  });
  $("btnFinalize").addEventListener("click", async () => {
    if (!state.life.txHash || state.busy) return;
    setBusy(true);
    try {
      await finalizeRun(state.life.txHash, { onProgress });
      await refreshTxStatus();
    } catch (error) {
      setLife({ phase: "consensus", error: true, message: errorText(error) });
    } finally {
      setBusy(false);
    }
  });
  refreshHealth();
  refresh();
  setInterval(() => {
    if (!state.busy && !document.hidden) refresh().catch(() => {});
  }, 25000);
}

boot();
