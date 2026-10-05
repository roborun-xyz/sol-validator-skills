import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const script=resolve(import.meta.dir,'../onboarding/scripts/onboard.ts');
const fixture=resolve(import.meta.dir,'fixtures/rpc-preload.ts');
test('first-use CLI persists verified RPC privately and revenue reuses it in a fresh session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'onboard-cli-'));const path=join(dir,'config.json');
 const run=async(args:string[],extra:Record<string,string>={})=>{
  const proc=Bun.spawn([process.execPath,'--preload',fixture,script,...args,'--config',path],{env:{...process.env,VALIDATOR_OPS_FLEET:join(dir,'absent-fleet.json'),VALIDATOR_OPS_HOST_INVENTORY:join(dir,'absent-hosts.md'),MY_FIXTURE_RPC:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY',SOLANA_RPC_URL:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY',...extra},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);return{out,err,code};
 };
 try {
  const add=['add','--profile','mine','--validator','11111111111111111111111111111111'];
  expect((await run(add,{FIXTURE_WRONG_NETWORK:'1'})).code).toBe(1);
  expect(await Bun.file(path).exists()).toBe(false);
  const ok=await run(add);expect(ok.code).toBe(0);expect(ok.out).not.toContain('TEST_ONLY');
  const saved=await readFile(path,'utf8');expect(JSON.parse(saved).version).toBe(2);expect(JSON.parse(saved).profiles.mine.rpcEnv).toBeUndefined();expect(JSON.parse(saved).profiles.mine.rpcUrl).toContain('TEST_ONLY');expect((await stat(path)).mode&0o777).toBe(0o600);
  expect((await run(add)).code).toBe(1);expect(await readFile(path,'utf8')).toBe(saved);
  const status=await run(['status']);expect(status.code).toBe(0);expect(JSON.parse(status.out).rpcConfigured.mine).toBe(true);
  const missing=await run(['refresh','--profile','mine'],{MY_FIXTURE_RPC:'',SOLANA_RPC_URL:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY'});
  expect(missing.code).toBe(0);expect(missing.out).not.toContain('TEST_ONLY');expect(JSON.parse(await readFile(path,'utf8')).profiles.mine.rpcUrl).toBe(JSON.parse(saved).profiles.mine.rpcUrl);
  const freshStatus=await run(['status'],{SOLANA_RPC_URL:'',MY_FIXTURE_RPC:''});expect(freshStatus.out).not.toContain('TEST_ONLY');expect(JSON.parse(freshStatus.out).rpcSource.mine).toBe('config');
  const revenue=Bun.spawn([process.execPath,'--preload',fixture,resolve(import.meta.dir,'../validator-revenue/scripts/revenue.ts'),'--epochs','1','--format','json'],{cwd:dir,env:{...process.env,SOLANA_RPC_URL:'',VALIDATOR_OPS_CONFIG:path},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(revenue.stdout).text(),new Response(revenue.stderr).text(),revenue.exited]);
  expect(err).toBe('');expect(code).toBe(0);expect(JSON.parse(out).rows[0].epoch).toBe(100);expect(out).not.toContain('TEST_ONLY');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('status works outside the bundle and diagnoses files independently without leaking invalid content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'onboard-status-'));
 const paths={config:join(dir,'config.json'),fleet:join(dir,'fleet.json'),hosts:join(dir,'hosts.md')};
 const run=async(extra:Record<string,string>={})=>{
  const proc=Bun.spawn([process.execPath,script,'status'],{cwd:dir,env:{...process.env,
   VALIDATOR_OPS_CONFIG:paths.config,VALIDATOR_OPS_FLEET:paths.fleet,VALIDATOR_OPS_HOST_INVENTORY:paths.hosts,...extra},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);return {out,err,code};
 };
 try {
  let result=await run();expect(result.code).toBe(0);
  for(const file of Object.values(JSON.parse(result.out).files) as any[]) expect(file.status).toBe('missing');
  await Bun.write(paths.config,'{"secret":"DO_NOT_PRINT"}');
  await Bun.write(paths.fleet,JSON.stringify({version:1,groups:{test:{mainnetBetaPubkey:'1'.repeat(32),testnetPubkey:'1'.repeat(32)}},hosts:[]}));
  await Bun.write(paths.hosts,'---\ncreated: 2026-09-16\nlast_updated: 2026-09-16\n---\n# DO_NOT_PRINT\n');
  result=await run();expect(result.code).toBe(0);expect(result.out).not.toContain('DO_NOT_PRINT');
  let files=JSON.parse(result.out).files;
  expect(files.profiles.status).toBe('invalid');expect(files.fleet.status).toBe('valid');expect(files.hosts.status).toBe('readable');
  await Bun.write(paths.fleet,'{"secret":"DO_NOT_PRINT"}');
  result=await run();expect(result.out).not.toContain('DO_NOT_PRINT');expect(JSON.parse(result.out).files.fleet.status).toBe('invalid');
  result=await run({VALIDATOR_OPS_HOST_INVENTORY:''});expect(result.code).toBe(1);expect(result.err).toContain('Empty configuration path');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('fresh HOME defaults resolve outside cwd and profile status survives absent Python setup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'onboard-home-'));
 const bundle=join(dir,'installed');
 try {
  for(const relative of ['onboarding/scripts/onboard.ts','onboarding/scripts/status.ts','shared/operator-config.ts','shared/base58.ts','shared/http.ts','shared/time.ts'])
   await Bun.write(join(bundle,'src/skills',relative),await Bun.file(resolve(import.meta.dir,'..',relative)).text());
  const home=join(dir,'operator');
  await Bun.write(join(home,'.config/validator-ops/config.json'),JSON.stringify({version:1,profiles:{}}));
  await Bun.write(join(home,'.config/validator-ops/fleet.json'),JSON.stringify({version:1,groups:{test:{mainnetBetaPubkey:'1'.repeat(32),testnetPubkey:'1'.repeat(32)}},hosts:[]}));
  const env: Record<string,string|undefined>={...process.env,HOME:home};
  delete env.VALIDATOR_OPS_CONFIG;delete env.VALIDATOR_OPS_FLEET;delete env.VALIDATOR_OPS_HOST_INVENTORY;
  const proc=Bun.spawn([process.execPath,join(bundle,'src/skills/onboarding/scripts/onboard.ts'),'status'],{cwd:dir,env,stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect(err).toBe('');expect(code).toBe(0);
  const files=JSON.parse(out).files;
  expect(files.profiles.path).toBe(join(home,'.config/validator-ops/config.json'));
  expect(files.profiles.status).toBe('valid');expect(files.fleet.status).toBe('unchecked');expect(files.hosts.status).toBe('missing');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('explicit legacy migration is atomic and identity refresh preserves saved URLs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'onboard-migrate-'));const path=join(dir,'config.json');
 const url='https://mainnet.helius-rpc.com/?api-key=TEST_ONLY';
 const profile={cluster:'mainnet-beta',voteAccount:'So11111111111111111111111111111111111111112',identity:'11111111111111111111111111111111',rpcEnv:'LEGACY_RPC',verification:{source:'helius-rpc',checkedAt:'2026-09-15T00:00:00Z'}};
 const run=async(args:string[],extra:Record<string,string>={})=>{
  const proc=Bun.spawn([process.execPath,'--preload',fixture,script,...args,'--config',path],{cwd:dir,env:{...process.env,SOLANA_RPC_URL:'',LEGACY_RPC:url,...extra},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);return {out,err,code};
 };
 try {
  await Bun.write(path,JSON.stringify({version:1,defaultProfile:'one',profiles:{one:profile,two:{...profile,rpcEnv:'MISSING_LEGACY_RPC'}}}));
  const before=await readFile(path,'utf8');
  const missing=await run(['migrate'],{MISSING_LEGACY_RPC:''});expect(missing.code).toBe(1);expect(await readFile(path,'utf8')).toBe(before);
  const wrong=await run(['migrate'],{MISSING_LEGACY_RPC:url,FIXTURE_WRONG_NETWORK:'1'});expect(wrong.code).toBe(1);expect(await readFile(path,'utf8')).toBe(before);
  const refresh=await run(['refresh','--profile','one']);expect(refresh.code).toBe(0);
  const mixed=JSON.parse(await readFile(path,'utf8'));expect(mixed.version).toBe(1);expect(mixed.profiles.one.rpcEnv).toBeUndefined();expect(mixed.profiles.two.rpcEnv).toBe('MISSING_LEGACY_RPC');
  const ok=await run(['migrate'],{MISSING_LEGACY_RPC:url});expect(ok.code).toBe(0);expect(ok.out).not.toContain('TEST_ONLY');
  const migrated=JSON.parse(await readFile(path,'utf8'));expect(migrated.version).toBe(2);expect(migrated.defaultProfile).toBe('one');expect(migrated.profiles.two.rpcEnv).toBeUndefined();expect(migrated.profiles.two.rpcUrl).toBe(url);
  const unchanged=await run(['refresh','--profile','one'],{SOLANA_RPC_URL:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY&label=SESSION_OVERRIDE'});expect(unchanged.code).toBe(0);expect(JSON.parse(await readFile(path,'utf8')).profiles.one.rpcUrl).toBe(url);
  const changed=await run(['refresh','--profile','one','--rpc','https://mainnet.helius-rpc.com/?api-key=TEST_ONLY&label=EXPLICIT_UPDATE']);expect(changed.code).toBe(0);expect(changed.out).not.toContain('EXPLICIT_UPDATE');expect(JSON.parse(await readFile(path,'utf8')).profiles.one.rpcUrl).toContain('EXPLICIT_UPDATE');
  const drift=JSON.parse(await readFile(path,'utf8'));drift.profiles.one.identity=drift.profiles.one.voteAccount;await Bun.write(path,JSON.stringify(drift));
  const driftBefore=await readFile(path,'utf8');expect((await run(['migrate'])).err).toContain('PROFILE_CONFLICT');expect(await readFile(path,'utf8')).toBe(driftBefore);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('RPC-only child commands retain optional default config semantics in a fresh home', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rpc-child-default-'));
 try {
  const module=resolve(import.meta.dir,'operator-config.ts');
  const childCode=`import {resolveRpc} from ${JSON.stringify(module)}; await resolveRpc(); console.log('child RPC configured');`;
  const parentCode=`import {createRpcContext} from ${JSON.stringify(module)}; const context=createRpcContext(); const child=Bun.spawn([process.execPath,'-e',${JSON.stringify(childCode)}],{cwd:${JSON.stringify(dir)},env:await context.environment(),stdout:'inherit',stderr:'inherit'}); process.exit(await child.exited);`;
  const env: Record<string,string|undefined>={...process.env,HOME:dir,SOLANA_RPC_URL:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY'};
  delete env.VALIDATOR_OPS_CONFIG;
  const proc=Bun.spawn([process.execPath,'-e',parentCode],{cwd:dir,env,stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect(code).toBe(0);expect(err).toBe('');expect(out).toContain('child RPC configured');expect(out).not.toContain('TEST_ONLY');
 } finally {await rm(dir,{recursive:true,force:true});}
});
