import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '../../..');
const scripts = [
 'onboarding/scripts/onboard.ts',
 'validator-performance/scripts/performance.ts',
 'validator-revenue/scripts/revenue.ts',
 'jito-bam-boost/scripts/check.ts',
 'marinade-bond-sweep/scripts/execute.ts',
 'jito-bam-boost/scripts/claim.ts',
 'votex-status/scripts/votex_status.ts',
 'votex-roi-sim/scripts/simulate.ts',
];
for (const script of scripts) {
 test(`${script} help works without RPC or operator configuration`, async () => {
  const env = {...process.env};
  delete env.SOLANA_RPC_URL;
  env.VALIDATOR_OPS_CONFIG = '/nonexistent/validator-ops-test/config.json';
  const result = Bun.spawn([process.execPath, resolve(root,'src/skills',script),'--help'], {
   cwd:tmpdir(), env, stdout:'pipe', stderr:'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  expect(code).toBe(0);
  expect(out+err).toMatch(/usage|onboard|preflight/i);
 });
}

for (const [script,args,expected] of [
 ['marinade-bond-sweep/scripts/execute.ts',['--execute','--dry-run'],'Unknown or duplicate'],
 ['jito-bam-boost/scripts/claim.ts',['--identity','11111111111111111111111111111111','--claim-epoch','1','--expected-amount-lamports','1','--keypair','/nonexistent/test-keypair'],'Required:'],
] as const) {
 test(`${script} rejects unsafe/incomplete execution before signer access`,async()=>{
  const proc=Bun.spawn([process.execPath,resolve(root,'src/skills',script),...args],{env:{...process.env,SOLANA_RPC_URL:''},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect(code).not.toBe(0);expect(out+err).toContain(expected);
 });
}

for (const script of ['validator-revenue/scripts/revenue.ts','validator-performance/scripts/performance.ts']) {
 test(`${script} omits credentials from unsupported argument diagnostics`,async()=>{
  const proc=Bun.spawn([process.execPath,resolve(root,'src/skills',script),'--rpc=https://mainnet.helius-rpc.com/?api-key=TEST_ONLY'],{stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect(code).toBe(1);expect(err).toContain('Unknown argument');expect(out+err).not.toContain('TEST_ONLY');
 });
}
