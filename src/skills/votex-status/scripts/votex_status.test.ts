import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function run(mode: string, extra:Record<string,string>={}, args = ["100", "--json", "--no-names", "--max-pages=2"]) {
  const proc = Bun.spawn([
    process.execPath, "--preload", resolve(import.meta.dir, "fixtures/offline-preload.ts"),
    resolve(import.meta.dir, "votex_status.ts"), ...args,
  ], {
    env: { ...process.env, VOTEX_FIXTURE_MODE: mode, SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=TEST_ONLY", ...extra },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

for (const mode of ["rpc-error", "null-tx", "missing-result", "missing-response", "duplicate-response", "invalid-meta", "truncated"]) {
  test(`on-chain fallback reports ${mode} as incomplete instead of zero bids`, async () => {
    const result = await run(mode);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Incomplete on-chain scan");
    expect(result.stderr).not.toContain("TEST_ONLY");
    if (mode === "truncated") expect(result.stderr).toContain("--max-pages=2 reached");
  });
}

test("a fully covered on-chain window can report a verified empty result", async () => {
  const result = await run("empty");
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.totalUsdcRaw).toBe("0");
  expect(output.scanWindow.complete).toBe(true);
  expect(output.scanWindow.signatureCandidates).toBe(0);
});

test("on-chain bids are counted once when batch responses arrive out of order", async () => {
  const result = await run("valid");
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.totalUsdcRaw).toBe("150000000");
  expect(output.rows[0].bidSharePct).toBe(100);
  expect(output.rows[0].transactions.map((tx: { amountRaw: string }) => tx.amountRaw)).toEqual(["100000000", "50000000"]);
  expect(output.scanWindow.complete).toBe(true);
});

test("unknown, duplicate or incomplete options are usage errors instead of being ignored", async () => {
  for (const args of [
    ["100", "--json", "--bogus"], ["100", "--json", "--json"], ["100", "--max-pages"],
    ["100", "--max-pages", "two"], ["100", "101"], ["100", "--json=1"],
  ]) {
    const result = await run("valid", {}, args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  }
});

test("the page limit is honored in either option form", async () => {
  for (const args of [["100", "--json", "--no-names", "--max-pages", "2"], ["--no-names", "--max-pages=2", "--json", "100"]]) {
    const result = await run("truncated", {}, args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--max-pages=2 reached");
  }
});

test("an on-chain vote buy in another mint fails like published stats instead of being skipped", async () => {
  const result = await run("other-mint");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("non-USDC vote buy (mint So11111111111111111111111111111111111111112)");
});

test("failed transactions do not contribute bids", async () => {
  const result = await run("failed-tx");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).totalUsdcRaw).toBe("0");
});


test("saved profile RPC supports an on-chain scan with no session environment URL",async()=>{
 const dir=await mkdtemp(join(tmpdir(),'votex-config-'));const config=join(dir,'config.json');
 try {
  await writeFile(config,JSON.stringify({version:2,profiles:{saved:{cluster:'mainnet-beta',identity:'11111111111111111111111111111111',voteAccount:'So11111111111111111111111111111111111111112',rpcUrl:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY',verification:{source:'helius-rpc',checkedAt:'2026-09-15T00:00:00Z'}}}}));
  const result=await run('valid',{SOLANA_RPC_URL:'',VALIDATOR_OPS_CONFIG:config});expect(result.code).toBe(0);expect(JSON.parse(result.stdout).totalUsdcRaw).toBe('150000000');expect(result.stdout+result.stderr).not.toContain('TEST_ONLY');
 } finally {await rm(dir,{recursive:true,force:true});}
});
