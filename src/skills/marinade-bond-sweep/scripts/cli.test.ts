import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactSecrets } from "./execute";

const fixture = resolve(import.meta.dir, "fixtures/offline-preload.ts");
const rpc = "https://mainnet.helius-rpc.com/?api-key=TEST_ONLY";

async function run(script: string, mode: string, args: string[], extra: Record<string,string> = {}) {
  const proc = Bun.spawn([process.execPath, "--preload", fixture, resolve(import.meta.dir, script), ...args], {
    env: { ...process.env, SOLANA_RPC_URL: rpc, SWEEP_FIXTURE_MODE: mode, ...extra },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function withSignerPaths(callback: (args: string[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "sweep-offline-"));
  try {
    for (const role of ["identity", "withdrawer", "fee-payer"]) {
      await writeFile(join(dir, `${role}.fixture`), "Offline path fixture; no key material", { mode: 0o600 });
    }
    await callback([
      "--vote-account", "fixture-vote", "--identity", "fixture-identity",
      "--identity-keypair", join(dir, "identity.fixture"),
      "--withdrawer-keypair", join(dir, "withdrawer.fixture"),
      "--fee-payer-keypair", join(dir, "fee-payer.fixture"),
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("planner help exits successfully before making any RPC request", async () => {
  const result = await run("plan.ts", "transport-error", ["--help"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Usage:");
});

test("executor rejects impossible sweeps in read-only and approved preflight before any mutation", async () => {
  await withSignerPaths(async (args) => {
    const approved = await run("execute.ts", "safe-plan", args);
    expect(approved.code).toBe(0);
    const approval = JSON.parse(approved.stdout).approval;
    for (const extra of [[], [
      "--execute", "--operator-approved", "--approval-id", approval.approvalId,
      "--approved-ceiling-lamports", approval.approvedCeilingLamports,
    ]]) {
      const result = await run("execute.ts", "below-floor-plan", [...args, ...extra]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("5 SOL hard floor");
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("UNEXPECTED_MUTATION_ATTEMPT");
    }
  });
});

for (const mode of ["rpc-error", "transport-error"]) {
  test(`planner hides credentials on ${mode}`, async () => {
    const result = await run("plan.ts", mode, ["--vote-account", "fixture-vote", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("RPC getAccountInfo failed");
    expect(result.stdout + result.stderr).not.toContain("TEST_ONLY");
  });
  test(`executor hides credentials on ${mode}`, async () => {
    await withSignerPaths(async (args) => {
      const result = await run("execute.ts", mode, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("RPC getBalance failed");
      expect(result.stdout + result.stderr).not.toContain("TEST_ONLY");
    });
  });
}

test("executor redacts configured credentials in child-process diagnostics", async () => {
  await withSignerPaths(async (args) => {
    const result = await run("execute.ts", "cli-error", args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("validator-bonds show-bond failed");
    expect(result.stdout + result.stderr).not.toContain("TEST_ONLY");
  });
  const reorderedUrl = "https://mainnet.helius-rpc.com/?commitment=finalized&api-key=TEST_ONLY";
  expect(redactSecrets(`Rejected TEST_ONLY at ${reorderedUrl}`, rpc)).not.toContain("TEST_ONLY");
});


test("saved RPC supports executor preflight and redacts child diagnostics without an environment URL",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sweep-config-"));const config=join(dir,"config.json");
 try {
  await writeFile(config,JSON.stringify({version:2,profiles:{saved:{cluster:'mainnet-beta',identity:'11111111111111111111111111111111',voteAccount:'So11111111111111111111111111111111111111112',rpcUrl:rpc,verification:{source:'helius-rpc',checkedAt:'2026-09-15T00:00:00Z'}}}}));
  await withSignerPaths(async(args)=>{
   const options=[...args,'--config',config,'--profile','saved'];
   const ok=await run('execute.ts','safe-plan',options,{SOLANA_RPC_URL:''});expect(ok.code).toBe(0);expect(ok.stdout).not.toContain('TEST_ONLY');
   const failed=await run('execute.ts','cli-error',options,{SOLANA_RPC_URL:''});expect(failed.code).toBe(1);expect(failed.stderr).toContain('validator-bonds show-bond failed');expect(failed.stdout+failed.stderr).not.toContain('TEST_ONLY');
  });
  const plan=await run('plan.ts','rpc-error',['--vote-account','fixture-vote','--config',config],{SOLANA_RPC_URL:''});expect(plan.stderr).toContain('RPC getAccountInfo failed');expect(plan.stderr).not.toContain('TEST_ONLY');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test("executor and planner share the approved endpoint despite a legacy default profile variable",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sweep-legacy-rpc-"));const config=join(dir,"config.json");
 try {
  await writeFile(config,JSON.stringify({version:1,defaultProfile:'legacy',profiles:{legacy:{cluster:'mainnet-beta',identity:'11111111111111111111111111111111',voteAccount:'So11111111111111111111111111111111111111112',rpcEnv:'LEGACY_RPC',verification:{source:'helius-rpc',checkedAt:'2026-09-15T00:00:00Z'}}}}));
  await withSignerPaths(async(args)=>{
   const selected=`${rpc}&label=approved`;
   const result=await run('execute.ts','planner-rpc-check',[...args,'--config',config,'--rpc',selected],{LEGACY_RPC:`${rpc}&label=legacy`,SWEEP_EXPECT_RPC:selected});
   expect(result.code).toBe(0);expect(JSON.parse(result.stdout).mutationPerformed).toBe(false);expect(result.stdout+result.stderr).not.toContain('TEST_ONLY');
  });
 } finally {await rm(dir,{recursive:true,force:true});}
});
