import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveBamTarget} from './check';
import {saveConfig,MAINNET_GENESIS} from '../../shared/operator-config';

test('BAM profiles verify current identity; historical explicit claimants bypass active-set lookup', async () => {
 const directory = await mkdtemp(join(tmpdir(),'bam-profile-'));
 const path = join(directory,'config.json');
 const identity = '11111111111111111111111111111111';
 const vote = 'So11111111111111111111111111111111111111112';
 const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY';
 try {
  await saveConfig({version:1,profiles:{example:{cluster:'mainnet-beta',identity,voteAccount:vote,rpcEnv:'CUSTOM_RPC',verification:{source:'helius-rpc',checkedAt:'2026-09-15T00:00:00Z'}}}},path);
  const call = async (_:string, method:string) => method === 'getGenesisHash' ? MAINNET_GENESIS : {current:[{votePubkey:vote,nodePubkey:identity}],delinquent:[]};
  expect((await resolveBamTarget({config:path,profile:'example',rpcUrl},call)).identity).toBe(identity);
  expect((await resolveBamTarget({config:path,profile:'example',identity:vote,rpcUrl},async()=>{throw new Error('must not query active set');})).identity).toBe(vote);
  await expect(resolveBamTarget({config:path,identity:'other-operators-host',rpcUrl},call)).rejects.toThrow();
  await expect(resolveBamTarget({config:path,profile:'missing',rpcUrl},call)).rejects.toThrow('Unknown');
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('BAM checker accepts the shared RPC override before rejecting an invalid claimant',async()=>{
 const {resolve}=await import('node:path');
 const proc=Bun.spawn([process.execPath,resolve(import.meta.dir,'check.ts'),'--rpc','https://mainnet.helius-rpc.com/?api-key=TEST_ONLY','--identity','invalid-fixture-key'],{stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
 expect(code).toBe(1);expect(err).toContain('Non-base58 character');expect(out+err).not.toContain('Usage:');expect(out+err).not.toContain('TEST_ONLY');
});

test('post-claim read waits for the Claim Status account and rejects a mismatched one at once',async()=>{
 const {PublicKey}=await import('@solana/web3.js');
 const {readFinalizedClaim}=await import('./check');
 const {BAM_BOOST_PROGRAM,deriveBamBoostClaimStatusAddress}=await import('../../shared/bam-accounts');
 const {pollReadOnly}=await import('../../shared/poll');
 const identity='11111111111111111111111111111111';
 const destination='So11111111111111111111111111111111111111112';
 const claim={identity,claimStatus:deriveBamBoostClaimStatusAddress(identity,100),destination,amountLamports:7n};
 const amount=(value:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(value);return b;};
 const claimStatus=(value:bigint)=>({owner:BAM_BOOST_PROGRAM.toBase58(),lamports:1,data:[Buffer.concat([Buffer.from([22,183,249,157,247,95,150,96]),new PublicKey(identity).toBuffer(),amount(value)]).toString('base64'),'base64']});
 const token=Buffer.alloc(165);new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn').toBuffer().copy(token);amount(42n).copy(token,64);
 const tokenAccount={owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',lamports:1,data:[token.toString('base64'),'base64']};
 let calls=0;let responses:unknown[][]=[];
 const original=globalThis.fetch;
 globalThis.fetch=(async()=>Response.json({jsonrpc:'2.0',id:1,result:{value:responses[Math.min(calls++,responses.length-1)]}})) as unknown as typeof fetch;
 try {
  // A lagging node serves no Claim Status first; only the two changed accounts are read.
  responses=[[null,null],[claimStatus(7n),tokenAccount]];
  expect(await pollReadOnly(()=>readFinalizedClaim('https://mainnet.helius-rpc.com/?api-key=TEST_ONLY',claim),3,0)).toEqual({destinationJitoSolBalanceLamports:42n});
  expect(calls).toBe(2);
  calls=0;responses=[[claimStatus(8n),tokenAccount]];
  await expect(pollReadOnly(()=>readFinalizedClaim('https://mainnet.helius-rpc.com/?api-key=TEST_ONLY',claim),3,0)).rejects.toThrow('did not match allocation');
  expect(calls).toBe(1);
 } finally {globalThis.fetch=original;}
});
