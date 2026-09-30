import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectInput, verifyValidator, saveConfig, readConfig, MAINNET_GENESIS, rpcCall, resolveOperator, selectRpc, validateConfig, redactRpc, type Config } from './operator-config';
const vote='R2D2vs3bJwpNF2ejaB6UW1JdCZ5VstuAmuwxDuUUWNj';
const identity='R2D2imoV8nXk1ngT9v4dEK65We4uLNyUarTBdWbFruq';
const url='https://mainnet.helius-rpc.com/?api-key=TEST_ONLY';
const profile={cluster:'mainnet-beta' as const,voteAccount:vote,identity,rpcEnv:'MY_RPC',verification:{source:'helius-rpc' as const,checkedAt:'2026-09-15T00:00:00Z'}};
const config:Config={version:1,profiles:{one:profile,two:profile}};
test('requires a selection for multiple profiles; honors default and explicit target',()=>{
 expect(()=>selectInput({},config,{MY_RPC:url})).toThrow('PROFILE_REQUIRED');
 expect(selectInput({}, {...config,defaultProfile:'one'},{MY_RPC:url}).target).toBe(vote);
 expect(selectInput({validator:identity},config,{SOLANA_RPC_URL:url}).target).toBe(identity);
 expect(()=>selectInput({profile:'missing'},config,{MY_RPC:url})).toThrow('Unknown');
});
test('reports missing setup and credentials without exposing secrets',()=>{
 expect(()=>selectInput({}, {version:1,profiles:{}},{})).toThrow('ONBOARDING_REQUIRED');
 expect(()=>selectInput({profile:'one'},config,{})).toThrow('ONBOARDING_REQUIRED');
 expect(()=>selectInput({validator:vote,rpcUrl:'https://example.com/?secret=hidden'},config,{})).toThrow('Mainnet RPC');
});
test('verifies network before accounts and handles ambiguity',async()=>{
 await expect(verifyValidator(vote,url,async()=> 'testnet')).rejects.toThrow('network mismatch');
 const account={votePubkey:vote,nodePubkey:identity};
 expect(await verifyValidator(identity,url,async(_,method)=>method==='getGenesisHash'?MAINNET_GENESIS:{current:[account],delinquent:[]})).toEqual({voteAccount:vote,identity});
 await expect(verifyValidator(identity,url,async(_,method)=>method==='getGenesisHash'?MAINNET_GENESIS:{current:[account,account],delinquent:[]})).rejects.toThrow('ambiguous');
});
test('saves private config with public fields only and round trips without changing default',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'operator-config-'));const path=join(dir,'config.json');
 try {
  await expect(saveConfig({...config,rpcUrl:url} as Config,path)).rejects.toThrow('Unknown');
  await saveConfig({...config,defaultProfile:'two'},path);
  expect((await readConfig(path)).defaultProfile).toBe('two');
  expect(await readFile(path,'utf8')).not.toContain('TEST_ONLY');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('explicit missing config is not silently replaced',async()=>{
 await expect(readConfig(join(tmpdir(),'no-config-'+crypto.randomUUID()))).rejects.toThrow('does not exist');
});

test('saved identity drift is blocked; explicit override is temporary',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'operator-drift-')); const path=join(dir,'config.json');
 try {
  await saveConfig({version:1,profiles:{one:profile}},path);
  const call=async(_:string,method:string)=>method==='getGenesisHash'?MAINNET_GENESIS:{current:[{votePubkey:vote,nodePubkey:vote}],delinquent:[]};
  await expect(resolveOperator({config:path,profile:'one',rpcUrl:url},call)).rejects.toThrow('PROFILE_CONFLICT');
  expect((await resolveOperator({config:path,profile:'one',voteAccount:vote,rpcUrl:url},call)).identity).toBe(vote);
  expect((await readConfig(path)).profiles.one.identity).toBe(identity);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('rejects coerced config fields, inherited profiles and wrong-length public keys', async () => {
 const { validateConfig, isPublicKey } = await import('./operator-config');
 expect(isPublicKey('1'.repeat(32))).toBe(true);
 expect(isPublicKey('1'.repeat(33))).toBe(false);
 expect(isPublicKey([vote])).toBe(false);
 for (const patch of [{rpcEnv:['MY_RPC']}, {identity:[identity]}, {verification:{source:'helius-rpc',checkedAt:123}}]) {
  expect(() => validateConfig({version:1, profiles:{one:{...profile,...patch}}})).toThrow();
 }
 expect(() => validateConfig({...config,defaultProfile:['one']})).toThrow();
 expect(() => selectInput({profile:'constructor'},config,{MY_RPC:url})).toThrow('Unknown');
 await expect(verifyValidator(vote,url,async(_,method)=>method==='getGenesisHash'?MAINNET_GENESIS:null)).rejects.toThrow('Invalid RPC');
});

test('RPC errors hide provider credentials and disable redirects', async () => {
 const original = globalThis.fetch;
 try {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
   expect(init?.redirect).toBe('error');
   throw new Error(url);
  }) as unknown as typeof fetch;
  let message = '';
  try { await rpcCall(url,'getGenesisHash'); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('RPC getGenesisHash failed');
  expect(message).not.toContain('TEST_ONLY');
 } finally { globalThis.fetch = original; }
});

test('historical queries resolve an existing zero-stake vote account without active-set membership',async()=>{
 const call=async(_:string,method:string)=>method==='getGenesisHash'?MAINNET_GENESIS:method==='getVoteAccounts'?{current:[],delinquent:[]}:{value:{owner:'Vote111111111111111111111111111111111111111',data:{parsed:{type:'vote',info:{nodePubkey:identity}}}}};
 expect(await verifyValidator(vote,url,call)).toEqual({voteAccount:vote,identity});
 await expect(verifyValidator(vote,url,async(u,m)=>m==='getAccountInfo'?{value:null}:call(u,m))).rejects.toThrow('existing vote account');
});

test('configuration paths expand home and reject empty overrides',async()=>{
 const {operatorPath} = await import('./operator-config');
 const {homedir} = await import('node:os');
 expect(operatorPath('~/example/config.json','TEST_OPERATOR_PATH','config.json')).toBe(join(homedir(),'example/config.json'));
 expect(()=>operatorPath('','TEST_OPERATOR_PATH','config.json')).toThrow('Empty configuration path');
 const previous=process.env.TEST_OPERATOR_PATH;
 try {
  process.env.TEST_OPERATOR_PATH='';
  expect(()=>operatorPath(undefined,'TEST_OPERATOR_PATH','config.json')).toThrow('Empty configuration path');
  expect(operatorPath('/explicit/config.json','TEST_OPERATOR_PATH','config.json')).toBe('/explicit/config.json');
 } finally { if(previous===undefined) delete process.env.TEST_OPERATOR_PATH; else process.env.TEST_OPERATOR_PATH=previous; }
});


test('v2 RPC precedence, whitespace fallback, explicit account settings and ambiguity', () => {
 const saved = {...profile, rpcUrl:url}; delete (saved as Partial<typeof profile>).rpcEnv;
 const cfg: Config = {version:2, profiles:{one:saved}};
 expect(selectRpc({},cfg,{}).rpcSource).toBe('config');
 expect(selectRpc({},cfg,{SOLANA_RPC_URL:'  '}).rpcUrl).toBe(url);
 const other='https://mainnet.helius-rpc.com/?api-key=TEST_ONLY&label=OTHER_TEST';
 expect(selectRpc({},cfg,{SOLANA_RPC_URL:other}).rpcUrl).toBe(other);
 expect(selectRpc({rpcUrl:url},cfg,{SOLANA_RPC_URL:other}).rpcUrl).toBe(url);
 expect(()=>selectRpc({},cfg,{SOLANA_RPC_URL:'invalid'})).toThrow('Invalid RPC');
 expect(selectInput({validator:identity},cfg,{}).target).toBe(identity);
 expect(selectInput({validator:identity},cfg,{}).rpcUrl).toBe(url);
 expect(()=>selectRpc({}, {...cfg,profiles:{one:saved,two:saved}},{})).toThrow('PROFILE_REQUIRED');
 expect(selectRpc({}, {...cfg,profiles:{one:saved,two:saved}}, {SOLANA_RPC_URL:url}).rpcUrl).toBe(url);
 expect(()=>validateConfig({version:2,profiles:{one:profile}})).toThrow();
 expect(()=>validateConfig({version:2,profiles:{one:{...saved,rpcUrl:42}}})).toThrow();
 expect(redactRpc(`Provider rejected ${url}; TEST_ONLY`,url)).not.toContain('TEST_ONLY');
});

test('saved v2 URLs round trip privately',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'operator-v2-')); const path=join(dir,'config.json');
 try {
  const {rpcEnv:_,...fields}=profile;
  await saveConfig({version:2,profiles:{one:{...fields,rpcUrl:url}}},path);
  expect((await readConfig(path)).profiles.one.rpcUrl).toBe(url);
  expect((await stat(path)).mode&0o777).toBe(0o600);
 } finally {await rm(dir,{recursive:true,force:true});}
});
