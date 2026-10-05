#!/usr/bin/env bun
import {resolveOperator,rpcCall,redactRpc,type Input,type RpcCaller} from '../../shared/operator-config';
import {localIso} from '../../shared/time';
import {CONFIG,STATE,POOL,decodeConfig,decodeSnapshot,delegationSummary} from './accounts';

export async function checkSteward(input:Input,includePool=false,call:RpcCaller=rpcCall) {
  const target=await resolveOperator(input,call);
  const initial=await call(target.rpcUrl,'getAccountInfo',[CONFIG,{encoding:'base64',commitment:'finalized'}]);
  const {validatorList}=decodeConfig(initial?.value);
  const snapshot=await call(target.rpcUrl,'getMultipleAccounts',[[CONFIG,STATE,validatorList,POOL],{encoding:'base64',commitment:'finalized',minContextSlot:initial.context.slot}]);
  if(!Array.isArray(snapshot?.value) || snapshot.value.length!==4 || !Number.isSafeInteger(snapshot.context?.slot) || snapshot.context.slot<initial.context.slot) throw new Error('Incomplete finalized Steward snapshot');
  if(decodeConfig(snapshot.value[0]).validatorList!==validatorList) throw new Error('Steward validator list changed during discovery; rerun');
  const decoded=decodeSnapshot(snapshot.value[1],snapshot.value[2],snapshot.value[3],validatorList);
  const epochInfo=await call(target.rpcUrl,'getEpochInfo',[{commitment:'finalized'}]);
  // Each rejected condition names its own cause; none is replaced with a partial result.
  if(!Number.isSafeInteger(epochInfo?.epoch)) throw new Error('Invalid RPC epoch response');
  const current=epochInfo.epoch;
  if(current<decoded.stateEpoch) throw new Error(`Steward state epoch ${decoded.stateEpoch} is ahead of finalized epoch ${current}; rerun`);
  if(current-decoded.stateEpoch>1) throw new Error(`Steward state is stale: state epoch ${decoded.stateEpoch}, finalized epoch ${current}`);
  if(decoded.nextCycleEpoch<current) throw new Error(`Steward next cycle epoch ${decoded.nextCycleEpoch} is behind finalized epoch ${current}`);
  if(decoded.nextCycleEpoch-current>100) throw new Error(`Implausible Steward next cycle epoch ${decoded.nextCycleEpoch} at finalized epoch ${current}`);
  const now=new Date();
  const validator=decoded.validators.find(v=>v.voteAccount===target.voteAccount)??null;
  const {validators,...cycle}=decoded;
  return {checkedAtUtc:now.toISOString(),checkedAtLocal:localIso(now),commitment:'finalized' as const,slot:snapshot.context.slot,currentEpoch:epochInfo.epoch,
    voteAccount:target.voteAccount,identity:target.identity,accounts:{config:CONFIG,state:STATE,pool:POOL,validatorList},...cycle,
    rankConvention:'1-based position in sorted_score_indices across all scored validators, including zero scores; ties retain on-chain order',
    status:!validator?'not_in_pool':validator.overallRank===null?'not_scored':'ranked',validator,
    ...(includePool?{poolSummary:delegationSummary(validators)}:{}),
    caveats:['Algorithmic target fractions are distinct from actual stake and directed stake. Directed stake is not decoded by this check.',
      'Active/transient stake is the SPL validator-list snapshot at lastUpdateEpoch, not a direct stake-account balance query.',
      'Rank and next cycle epoch do not guarantee future delegation or stake timing.']};
}
export function parseArgs(args:string[]) {
  const input:Input={}; let format='markdown',pool=false;const seen=new Set<string>();
  for(let i=0;i<args.length;i++) {
    const [flag,...inline]=args[i].split('=');
    if(seen.has(flag)) throw new Error('Duplicate option'); seen.add(flag);
    if(flag==='--pool-summary' && !inline.length) {pool=true;continue;}
    const keys:Record<string,keyof Input>={'--profile':'profile','--config':'config','--rpc':'rpcUrl','--vote-account':'voteAccount','--validator':'validator'};
    if(!(flag in keys) && flag!=='--format') throw new Error('Unknown argument; use --help');
    const value=inline.length?inline.join('='):args[++i];
    if(!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if(flag==='--format') {if(!['json','markdown'].includes(value))throw new Error('Format must be json or markdown');format=value;}
    else input[keys[flag]]=value;
  }
  if(input.voteAccount && input.validator) throw new Error('Use either --vote-account or --validator');
  return {input,format,pool};
}
export function markdown(result:Awaited<ReturnType<typeof checkSteward>>) {
  const v=result.validator;
  const lines=[`[On-chain observation] JitoSOL Steward: ${result.voteAccount}`,
    `[On-chain observation] ${result.checkedAtUtc} / ${result.checkedAtLocal}; finalized slot ${result.slot}; epoch ${result.currentEpoch}`,
    `[On-chain observation] Status: ${result.status}; Overall Rank: ${v?.overallRank??'unavailable'}/${result.scoredCount}; score: ${v?.score??'unavailable'}`,
    `[On-chain observation] Target: ${v?(v.delegation.numerator>0?`${v.delegation.numerator}/${v.delegation.denominator}`:'none'):'unavailable'}; active stake: ${v?.activeStakeSol??'unavailable'} SOL; transient: ${v?.transientStakeSol??'unavailable'} SOL`,
    `[On-chain observation] Instant unstake: ${v?.instantUnstake??'unavailable'}; stake update epoch: ${v?.lastUpdateEpoch??'unavailable'}; state epoch: ${result.stateEpoch}; next cycle: ${result.nextCycleEpoch}`,
    `[Official layout] ${result.rankConvention}`];
  if(result.poolSummary) lines.push(`[On-chain observation] Target members: ${result.poolSummary.memberCount}; fractions: ${JSON.stringify(result.poolSummary.fractions)}; above 1/${result.poolSummary.memberCount}: ${result.poolSummary.aboveEqualShare.length}`,
    '', '| Vote account | Active stake SOL | Target |', '|---|---:|---|',...result.poolSummary.topActiveStake.map(row=>`| ${row.voteAccount} | ${row.activeStakeSol.toFixed(9)} | ${row.delegation.numerator}/${row.delegation.denominator} |`));
  lines.push(...result.caveats.map(c=>`[Accounting limitation] ${c}`));return lines.join('\n')+'\n';
}
if(import.meta.main) {
  if(process.argv.includes('--help')) {console.log('Usage: bun src/skills/jitosol-steward/scripts/check.ts [--profile NAME | --vote-account PUBKEY | --validator PUBKEY] [--config PATH] [--rpc URL] [--pool-summary] [--format markdown|json]');process.exit(0);}
  try {const options=parseArgs(process.argv.slice(2));const result=await checkSteward(options.input,options.pool);console.log(options.format==='json'?JSON.stringify(result,null,2):markdown(result).trimEnd());}
  catch(error) {console.error(redactRpc(error instanceof Error?error.message:String(error)));process.exit(1);}
}
