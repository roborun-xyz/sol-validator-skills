import {test, expect} from 'bun:test';
import {PublicKey} from '@solana/web3.js';
import {localIso} from './time';
import {formatSol, lamportsToSol} from './amounts';
import {decodeVaultEpochInfo} from './votex-accounts';
import {parseEpochQueryArgs, optionValue} from './cli';
import {deriveBamBoostAddresses, deriveBamBoostClaimStatusAddress, verifyBamBoostClaimStatusAccount, BAM_BOOST_PROGRAM} from './bam-accounts';
import {fetchSvtHistory} from './epoch-history';

const help = (): never => {throw new Error('help requested');};

test('epoch report arguments preserve overrides and reject missing values and unsafe epoch counts',()=>{
 expect(parseEpochQueryArgs(['validator','-n','2','--include-current','--format','json','--profile','one','--rpc','https://mainnet.helius-rpc.com/'],help)).toMatchObject({validator:'validator',epochs:2,includeCurrent:true,format:'json',profile:'one'});
 for(const args of [['--epochs','9007199254740992'],['--epochs','1.5'],['--epochs','--format','json'],['--format','xml'],['--unknown']]) expect(()=>parseEpochQueryArgs(args,help)).toThrow();
 expect(()=>parseEpochQueryArgs(['--help'],help)).toThrow('help requested');
 expect(optionValue(['--rpc=https://mainnet.helius-rpc.com/?label=value'],'--rpc')).toBe('https://mainnet.helius-rpc.com/?label=value');
 expect(()=>optionValue(['--config','--profile','one'],'--config')).toThrow('Missing value');
});

test('timestamp formatting preserves explicit offsets across midnight and daylight saving time',()=>{
 expect(localIso(new Date('2026-09-30T16:00:00Z'))).toBe('2026-10-01T00:00:00+08:00');
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
 } finally {globalThis.fetch=original;}
});
