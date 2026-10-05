import {test, expect} from 'bun:test';
import {PublicKey} from '@solana/web3.js';
import {localIso, localTimeZone} from './time';
import {formatSol, lamportsToSol} from './amounts';
import {decodeVaultEpochInfo, assertUsdcVoteBuys, USDC_MINT} from './votex-accounts';
import {parseEpochQueryArgs, optionValue} from './cli';
import {deriveBamBoostAddresses, deriveBamBoostClaimStatusAddress, verifyBamBoostClaimStatusAccount, BAM_BOOST_PROGRAM} from './bam-accounts';
import {fetchSvtHistory, unavailableEpochsNote, leaderSkipRatePct} from './epoch-history';
import {pollReadOnly} from './poll';
import {TransportError} from './http';

const help = (): never => {throw new Error('help requested');};

test('epoch report arguments preserve overrides and reject missing values and unsafe epoch counts',()=>{
 expect(parseEpochQueryArgs(['validator','-n','2','--include-current','--format','json','--profile','one','--rpc','https://mainnet.helius-rpc.com/'],help)).toMatchObject({validator:'validator',epochs:2,includeCurrent:true,format:'json',profile:'one'});
 for(const args of [['--epochs','9007199254740992'],['--epochs','1.5'],['--epochs','--format','json'],['--format','xml'],['--unknown']]) expect(()=>parseEpochQueryArgs(args,help)).toThrow();
 expect(()=>parseEpochQueryArgs(['--help'],help)).toThrow('help requested');
 expect(optionValue(['--rpc=https://mainnet.helius-rpc.com/?label=value'],'--rpc')).toBe('https://mainnet.helius-rpc.com/?label=value');
 expect(()=>optionValue(['--config','--profile','one'],'--config')).toThrow('Missing value');
});

test('timestamp formatting preserves explicit offsets across midnight and daylight saving time',()=>{
 expect(localIso(new Date('2026-09-30T16:00:00Z'),'Asia/Shanghai')).toBe('2026-10-01T00:00:00+08:00');
 // Local time defaults to UTC; only a nonblank LOCAL_TIME_ZONE changes it.
 expect(localTimeZone({})).toBe('UTC');expect(localTimeZone({LOCAL_TIME_ZONE:'  '})).toBe('UTC');
 expect(localTimeZone({LOCAL_TIME_ZONE:' America/Los_Angeles '})).toBe('America/Los_Angeles');
 expect(localIso(new Date('2026-09-30T16:00:00Z'),localTimeZone({}))).toBe('2026-09-30T16:00:00+00:00');
 expect(()=>localIso(new Date(),'Not/AZone')).toThrow();
 expect(localIso(new Date('2026-07-01T00:00:00Z'),'America/Los_Angeles')).toBe('2026-06-30T17:00:00-07:00');
 expect(localIso(new Date('2026-01-01T00:00:00Z'),'America/Los_Angeles')).toBe('2025-12-31T16:00:00-08:00');
 expect(localIso(new Date('2026-09-30T00:00:00Z'),'UTC')).toBe('2026-09-30T00:00:00+00:00');
});

test('exact SOL formatting preserves signs, single lamports and values above Number precision',()=>{
 expect(formatSol(1n)).toBe('0.000000001');
 expect(formatSol(-1n)).toBe('-0.000000001');
 expect(formatSol(9007199254740993n)).toBe('9007199.254740993');
 expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
});

test('Vault status and ROI derive the same target epoch and time window from account bytes',()=>{
 const data=Buffer.alloc(185);
 data.writeUInt32LE(86400,169);data.writeUInt32LE(42,173);data.writeBigInt64LE(1_800_000_000n,177);
 expect(decodeVaultEpochInfo(data)).toEqual({epochDurationSeconds:86400,currentRewardsEpoch:42,activeVoteBuyTargetEpoch:43,currentEpochStart:1_799_913_600,nextEpochStartsAt:1_800_000_000});
 expect(()=>decodeVaultEpochInfo(data.subarray(0,184))).toThrow('data too short');
});

test('BAM consumers share the known claim PDA and reject invalid finalized claim accounts',()=>{
 const identity='R2D2imoV8nXk1ngT9v4dEK65We4uLNyUarTBdWbFruq';
 const addresses=deriveBamBoostAddresses(new PublicKey(identity),1028);
 expect(addresses.claimStatus.toBase58()).toBe('EKbgiJ8yD4AYRDY3iT75bEAD628vs3kyHSNJ7y1dtD2a');
 expect(deriveBamBoostClaimStatusAddress(identity,1028)).toBe(addresses.claimStatus.toBase58());
 expect(()=>deriveBamBoostAddresses(new PublicKey(identity),-1)).toThrow('Invalid BAM claim epoch');
 const data=Buffer.alloc(48);Buffer.from([22,183,249,157,247,95,150,96]).copy(data);new PublicKey(identity).toBuffer().copy(data,8);data.writeBigUInt64LE(42n,40);
 const account={owner:BAM_BOOST_PROGRAM.toBase58(),data:[data.toString('base64'),'base64'] as [string,string]};
 expect(()=>verifyBamBoostClaimStatusAccount(account,identity,42n)).not.toThrow();
 expect(()=>verifyBamBoostClaimStatusAccount({...account,owner:identity},identity,42n)).toThrow('owner');
 const bad=Buffer.from(data);bad[0]=0;
 expect(()=>verifyBamBoostClaimStatusAccount({...account,data:[bad.toString('base64'),'base64']},identity,42n)).toThrow('discriminator');
});

test('shared SVT history filters and orders rows while rejecting incomplete windows',async()=>{
 const original=globalThis.fetch;
 let rows: {epoch:number}[]=[{epoch:101},{epoch:99},{epoch:100},{epoch:98}];
 try {
  globalThis.fetch=(async(input:unknown,init?:RequestInit)=>{
   const url=new URL(String(input));expect(url.searchParams.get('vote_id')).toBe('fixture-vote');expect(url.searchParams.get('epoch_from')).toBe('101');expect(init?.redirect).toBe('error');
   return Response.json({data:rows});
  }) as typeof fetch;
  expect(await fetchSvtHistory('fixture-vote',99,101,3)).toEqual([{epoch:99},{epoch:100},{epoch:101}]);
  rows=[{epoch:99},{epoch:101}];await expect(fetchSvtHistory('fixture-vote',99,101,3)).rejects.toThrow('missing epoch(s): 100');
  // History that starts late shortens the window; a missing latest epoch or no rows still fails.
  rows=[{epoch:100},{epoch:101}];expect(await fetchSvtHistory('fixture-vote',99,101,3)).toEqual([{epoch:100},{epoch:101}]);
  rows=[{epoch:99},{epoch:100}];await expect(fetchSvtHistory('fixture-vote',99,101,3)).rejects.toThrow('missing epoch(s): 101');
  rows=[{epoch:98}];await expect(fetchSvtHistory('fixture-vote',99,101,3)).rejects.toThrow('no rows for epochs 99-101');
  expect(unavailableEpochsNote(99,100,101)).toEqual(['Requested epochs `99-101`; JPool/SVT history starts at epoch `100`, so epochs `99-99` are unavailable and excluded.']);
  expect(unavailableEpochsNote(99,99,101)).toEqual([]);
 } finally {globalThis.fetch=original;}
});

test('skip rate needs both leader-slot counts and never treats a missing count as zero blocks',()=>{
 expect(leaderSkipRatePct(10,9)).toBe(10);expect(leaderSkipRatePct('10','0')).toBe(100);
 for(const [total,done] of [[10,undefined],[10,null],[10,-1],[10,11],[0,0],[undefined,5],[10,'']]) expect(leaderSkipRatePct(total,done)).toBeNull();
});

test('read-only polling stops on the first defined value and stays bounded',async()=>{
 let calls=0;
 expect(await pollReadOnly(async()=>++calls<3?undefined:'ready',5,0)).toBe('ready');expect(calls).toBe(3);
 calls=0;expect(await pollReadOnly(async()=>{calls++;return undefined;},4,0)).toBeUndefined();expect(calls).toBe(4);
 // A transport error is retried; only one on the final attempt surfaces.
 calls=0;expect(await pollReadOnly(async()=>{if(++calls===1)throw new TransportError('transient');return 'ok';},3,0)).toBe('ok');
 calls=0;await expect(pollReadOnly(async()=>{calls++;throw new TransportError('still failing');},3,0)).rejects.toThrow('still failing');expect(calls).toBe(3);
 // Any other error is a real failure: it surfaces at once unless the caller opts in.
 calls=0;await expect(pollReadOnly(async()=>{calls++;throw new Error('invalid account');},3,0)).rejects.toThrow('invalid account');expect(calls).toBe(1);
 calls=0;expect(await pollReadOnly(async()=>{if(++calls===1)throw new Error('read-only command failed');return 'ok';},3,0,()=>true)).toBe('ok');
});

test('published vote buys in another mint are rejected rather than summed as USDC',()=>{
 expect(()=>assertUsdcVoteBuys([{mint:USDC_MINT}],57)).not.toThrow();expect(()=>assertUsdcVoteBuys([],57)).not.toThrow();
 expect(()=>assertUsdcVoteBuys([{mint:USDC_MINT},{mint:'So11111111111111111111111111111111111111112'}],57)).toThrow('non-USDC vote buy (mint So1');
 // A missing or non-string mint is unknown, not USDC.
 for(const buy of [{},{mint:null},{mint:7}]) expect(()=>assertUsdcVoteBuys([{mint:USDC_MINT},buy],57)).toThrow('mint missing or invalid');
});
