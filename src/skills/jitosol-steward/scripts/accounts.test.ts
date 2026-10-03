import {test,expect} from 'bun:test';
import {PublicKey} from '@solana/web3.js';
import {decodeSnapshot,decodeConfig,discriminator,delegationSummary,STATE_SIZE,OFFSETS,PROGRAM,POOL_PROGRAM,POOL,type Account} from './accounts';
import {parseArgs} from './check';
function account(b:Buffer,owner:string):Account {return {owner,executable:false,data:[b.toString('base64'),'base64']};}
function fixture() {
  const listKey=new PublicKey(Buffer.alloc(32,9)).toBase58();
  const pool=Buffer.alloc(611);pool[0]=1;new PublicKey(listKey).toBuffer().copy(pool,98);
  // SPL capacity can exceed Steward MAX; only populated indices must fit.
  const list=Buffer.alloc(9+10000*73);list[0]=2;list.writeUInt32LE(10000,1);list.writeUInt32LE(4,5);
  for(let i=0;i<4;i++){Buffer.alloc(32,i+1).copy(list,9+i*73+41);list.writeBigUInt64LE(BigInt((i+1)*1e9),9+i*73);}
  const state=Buffer.alloc(STATE_SIZE);discriminator('StewardStateAccountV2').copy(state);state.writeBigUInt64LE(2n,8);
  state.writeBigUInt64LE(42n,OFFSETS.metadata+8);state.writeBigUInt64LE(45n,OFFSETS.metadata+16);state.writeBigUInt64LE(3n,OFFSETS.metadata+24);state.writeUInt32LE(1,OFFSETS.metadata+56);
  [100n,100n,0n].forEach((v,i)=>state.writeBigUInt64LE(v,OFFSETS.scores+i*8));[1,0,2].forEach((v,i)=>state.writeUInt16LE(v,OFFSETS.sorted+i*2));
  for(const i of [0,1]){state.writeUInt32LE(1,OFFSETS.delegations+i*8);state.writeUInt32LE(2,OFFSETS.delegations+i*8+4);}
  state.writeBigUInt64LE(2n,OFFSETS.instant);
  const decode=()=>decodeSnapshot(account(state,PROGRAM),account(list,POOL_PROGRAM),account(pool,POOL_PROGRAM),listKey);
  return {state,list,pool,listKey,decode};
}
test('overall position includes zero scores, on-chain tie order and unscored additions',()=>{
  const r=fixture().decode();expect(r.validators.map(v=>v.overallRank)).toEqual([2,1,3,null]);expect(r.validators[3].score).toBeNull();expect(r.validators[1].instantUnstake).toBe(true);expect(delegationSummary(r.validators).aboveEqualShare).toEqual([]);
});
test('incomplete score cycle is unavailable, not rank zero',()=>{const f=fixture();f.state.writeUInt32LE(0,OFFSETS.metadata+56);f.state.writeUInt16LE(65535,OFFSETS.sorted);expect(f.decode().validators.every(v=>v.overallRank===null)).toBe(true);});
test('reject duplicate, out of bounds and incorrectly sorted rank indices',()=>{
  for(const index of [1,4]){const f=fixture();f.state.writeUInt16LE(index,OFFSETS.sorted+2);expect(f.decode).toThrow('score index');}
  const f=fixture();f.state.writeBigUInt64LE(101n,OFFSETS.scores);expect(f.decode).toThrow('score index');
});
test('fail closed for unsupported owner/discriminator/layout and list link',()=>{
  const f=fixture();expect(()=>decodeSnapshot(account(f.state,POOL_PROGRAM),account(f.list,POOL_PROGRAM),account(f.pool,POOL_PROGRAM),f.listKey)).toThrow();
  f.state[0]^=1;expect(f.decode).toThrow('layout/discriminator');
  const g=fixture();g.pool[98]^=1;expect(g.decode).toThrow('link mismatch');
  const h=fixture();h.list.writeUInt32LE(5001,5);expect(h.decode).toThrow('layout');
});
test('positive fractions validated and compared using exact arithmetic',()=>{
  const f=fixture();f.state.writeUInt32LE(0,OFFSETS.delegations+4);expect(f.decode).toThrow('fraction');
  const g=fixture();g.state.writeUInt32LE(3,OFFSETS.delegations+4);const summary=delegationSummary(g.decode().validators);expect(summary.aboveEqualShare.map(v=>v.listIndex)).toEqual([]);
  g.state.writeUInt32LE(1,OFFSETS.delegations+4);expect(delegationSummary(g.decode().validators).aboveEqualShare.map(v=>v.listIndex)).toEqual([0]);
});
test('config discriminator and pool link are verified',()=>{
  const c=Buffer.alloc(72);discriminator('Config').copy(c);new PublicKey(POOL).toBuffer().copy(c,8);expect(decodeConfig(account(c,PROGRAM))).toBeDefined();c[0]^=1;expect(()=>decodeConfig(account(c,PROGRAM))).toThrow('discriminator');
});
test('CLI permits explicit target with profile and inline shared flags; refuses ambiguous target',()=>{
  expect(parseArgs(['--profile=p','--vote-account=v','--format=json','--pool-summary']).input).toEqual({profile:'p',voteAccount:'v'});
  expect(()=>parseArgs(['--vote-account','v','--validator','i'])).toThrow();expect(()=>parseArgs(['--rpc'])).toThrow();
});

test('checker joins links at one finalized slot and distinguishes not_in_pool',async()=>{
  const {checkSteward}=await import('./check');
  const {MAINNET_GENESIS}=await import('../../shared/operator-config');
  const f=fixture(),config=Buffer.alloc(72);discriminator('Config').copy(config);new PublicKey(POOL).toBuffer().copy(config,8);new PublicKey(f.listKey).toBuffer().copy(config,40);
  const vote=new PublicKey(Buffer.alloc(32,8)).toBase58(),identity=new PublicKey(Buffer.alloc(32,7)).toBase58();
  const calls:Array<{method:string;params:any}>=[];
  const call=async(_url:string,method:string,params:any=[])=>{
    calls.push({method,params});
    if(method==='getGenesisHash')return MAINNET_GENESIS;
    if(method==='getVoteAccounts')return {current:[{votePubkey:vote,nodePubkey:identity}],delinquent:[]};
    if(method==='getAccountInfo')return {context:{slot:100},value:account(config,PROGRAM)};
    if(method==='getMultipleAccounts')return {context:{slot:101},value:[account(config,PROGRAM),account(f.state,PROGRAM),account(f.list,POOL_PROGRAM),account(f.pool,POOL_PROGRAM)]};
    if(method==='getEpochInfo')return {epoch:42};
    throw new Error('Unexpected method');
  };
  const result=await checkSteward({voteAccount:vote,rpcUrl:'https://mainnet.helius-rpc.com/?api-key=TEST_ONLY'},true,call);
  expect(result.status).toBe('not_in_pool');expect(result.validator).toBeNull();expect(result.poolSummary?.memberCount).toBe(2);
  const snapshot=calls.find(c=>c.method==='getMultipleAccounts')!;expect(snapshot.params[0]).toHaveLength(4);expect(snapshot.params[1]).toEqual({encoding:'base64',commitment:'finalized',minContextSlot:100});expect(result.slot).toBe(101);
});
