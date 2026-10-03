import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';

export const PROGRAM = 'Stewardf95sJbmtcZsyagb2dg4Mo8eVQho8gpECvLx8';
export const CONFIG = 'jitoVjT9jRUyeXHzvCwzPgHj7yWNRhLcUoXtes4wtjv';
export const POOL = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb';
export const POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy';
export const STATE = PublicKey.findProgramAddressSync([Buffer.from('steward_state'), new PublicKey(CONFIG).toBuffer()], new PublicKey(PROGRAM))[0].toBase58();
export const MAX = 5000;
export const OFFSETS = {scores:16 + MAX*8, sorted:16 + MAX*16, delegations:16 + MAX*20, instant:16 + MAX*28, metadata:16 + MAX*28 + 4*632};
export const STATE_SIZE = OFFSETS.metadata + 64 + MAX*8 + 8;
export type Account = {owner:string; executable:boolean; data:[string,string]};
export function discriminator(name:string) {return createHash('sha256').update(`account:${name}`).digest().subarray(0,8);}
function bytes(account:Account|null, owner:string, length:number, name:string) {
  if (!account || account.owner!==owner || account.executable || account.data?.[1]!=='base64') throw new Error(`Invalid ${name} account owner or encoding`);
  const data=Buffer.from(account.data[0],'base64');
  if(data.length<length) throw new Error(`Truncated ${name} account`);
  return data;
}
export function decodeConfig(account:Account|null) {
  const data=bytes(account,PROGRAM,72,'Steward config');
  if(!data.subarray(0,8).equals(discriminator('Config'))) throw new Error('Invalid Steward config discriminator');
  if(new PublicKey(data.subarray(8,40)).toBase58()!==POOL) throw new Error('Unexpected JitoSOL stake pool');
  return {validatorList:new PublicKey(data.subarray(40,72)).toBase58()};
}
function safeU64(data:Buffer, offset:number, name:string) {
  const value=data.readBigUInt64LE(offset);
  if(value>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${name}`);
  return Number(value);
}
export function decodeSnapshot(stateAccount:Account|null,listAccount:Account|null,poolAccount:Account|null,listAddress:string) {
  const pool=bytes(poolAccount,POOL_PROGRAM,130,'stake pool');
  if(pool[0]!==1 || new PublicKey(pool.subarray(98,130)).toBase58()!==listAddress) throw new Error('Stake pool validator-list link mismatch');
  const list=bytes(listAccount,POOL_PROGRAM,9,'validator list');
  const capacity=list.readUInt32LE(1), count=list.readUInt32LE(5);
  if(list[0]!==2 || count>MAX || count>capacity || list.length!==9+capacity*73) throw new Error('Invalid validator-list layout');
  const state=bytes(stateAccount,PROGRAM,STATE_SIZE,'Steward state V2');
  if(state.length!==STATE_SIZE || !state.subarray(0,8).equals(discriminator('StewardStateAccountV2'))) throw new Error('Unsupported Steward state layout/discriminator');
  const stateTag=safeU64(state,8,'state tag');
  if(stateTag>5) throw new Error('Unknown Steward state tag');
  const epoch=safeU64(state,OFFSETS.metadata+8,'Steward epoch');
  const nextCycleEpoch=safeU64(state,OFFSETS.metadata+16,'next cycle');
  const scoredCount=safeU64(state,OFFSETS.metadata+24,'scored count');
  if(scoredCount>count || nextCycleEpoch<epoch) throw new Error('Invalid Steward cycle metadata');
  const scoreComplete=(state.readUInt32LE(OFFSETS.metadata+56)&1)!==0;
  const sorted=Array.from({length:scoredCount},(_,i)=>state.readUInt16LE(OFFSETS.sorted+i*2));
  const score=(i:number)=>state.readBigUInt64LE(OFFSETS.scores+i*8);
  // A cycle in ComputeScores has partially populated arrays; never present a final rank.
  if(scoreComplete && (new Set(sorted).size!==scoredCount || sorted.some(i=>i>=scoredCount) || sorted.some((v,i)=>i>0 && score(v)>score(sorted[i-1])))) throw new Error('Invalid descending Steward score index');
  const seen=new Set<string>();
  const validators=Array.from({length:count},(_,index)=>{
    const offset=9+index*73, delegationOffset=OFFSETS.delegations+index*8;
    const voteAccount=new PublicKey(list.subarray(offset+41,offset+73)).toBase58();
    if(seen.has(voteAccount)) throw new Error('Duplicate vote account in validator list');
    seen.add(voteAccount);
    const numerator=state.readUInt32LE(delegationOffset), denominator=state.readUInt32LE(delegationOffset+4);
    if(numerator>0 && (!denominator || numerator>denominator)) throw new Error('Invalid positive delegation fraction');
    const scored=scoreComplete && index<scoredCount;
    return {voteAccount,listIndex:index,overallRank:scored?sorted.indexOf(index)+1:null,score:scored?score(index).toString():null,
      delegation:{numerator,denominator},instantUnstake:(state.readBigUInt64LE(OFFSETS.instant+Math.floor(index/64)*8)&(1n<<BigInt(index%64)))!==0n,
      activeStakeLamports:list.readBigUInt64LE(offset).toString(),transientStakeLamports:list.readBigUInt64LE(offset+8).toString(),
      activeStakeSol:Number(list.readBigUInt64LE(offset))/1e9,transientStakeSol:Number(list.readBigUInt64LE(offset+8))/1e9,lastUpdateEpoch:safeU64(list,offset+16,'stake update epoch'),stakeStatus:list[offset+40]};
  });
  return {stateTag,stateEpoch:epoch,nextCycleEpoch,scoredCount,listCount:count,scoreComplete,validators};
}
export function delegationSummary(validators:ReturnType<typeof decodeSnapshot>['validators']) {
  const members=validators.filter(v=>v.delegation.numerator>0);
  const fractions:Record<string,number>={};
  for(const v of members) {const key=`${v.delegation.numerator}/${v.delegation.denominator}`;fractions[key]=(fractions[key]??0)+1;}
  return {memberCount:members.length,fractions,aboveEqualShare:members.filter(v=>BigInt(v.delegation.numerator)*BigInt(members.length)>BigInt(v.delegation.denominator)),
    topActiveStake:[...validators].sort((a,b)=>BigInt(a.activeStakeLamports)>BigInt(b.activeStakeLamports)?-1:BigInt(a.activeStakeLamports)<BigInt(b.activeStakeLamports)?1:0).slice(0,5)};
}
