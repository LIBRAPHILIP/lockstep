/**
 * Read the deployed Lockstep contract and check the public rules.
 *
 *   node scripts/verify-live.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployed = JSON.parse(readFileSync(path.join(root, "src", "deployed.json"), "utf8"));

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function main() {
  if (!deployed.address) throw new Error("src/deployed.json has no address");
  const client = createClient({ chain: studionet });
  const meta = asObject(await client.readContract({ address: deployed.address, functionName: "get_meta", args: [] }));
  console.log("meta", meta);
  if (meta.version !== "1.0.0-lockstep") throw new Error("version");
  if (meta.llm_rule !== "none") throw new Error("llm_rule");
  if (meta.category !== "workflow-automation") throw new Error("category");
  if (meta.source_rule !== "contract_built_https_only") throw new Error("source_rule");
  const preview = asObject(
    await client.readContract({
      address: deployed.address,
      functionName: "preview_manifest",
      args: ["fact npm left-pad 1.3.0\nattest 0x1111111111111111111111111111111111111111\n"],
    })
  );
  if (preview.gates?.[0]?.source !== "https://registry.npmjs.org/left-pad/1.3.0") {
    throw new Error("bad preview " + JSON.stringify(preview));
  }
  const hostile = asObject(
    await client.readContract({
      address: deployed.address,
      functionName: "preview_manifest",
      args: ["fact http example.com 1.0.0\nfact npm left-pad 1.3.0\n"],
    })
  );
  if (hostile.error !== "bad_authority") throw new Error("hostile spec was accepted " + JSON.stringify(hostile));
  console.log("verify ok", deployed.address, "runs", meta.run_count);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
