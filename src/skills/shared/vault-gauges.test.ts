import {test,expect} from 'bun:test';
import {base58Decode} from './base58';
import {VAULT_GAUGEMEISTER} from './votex-accounts';
import {IncompleteGaugeLookupError,isActiveVaultGauge,gaugeQuarry,quarryTokenMint,matchGaugesByName,findVaultGaugesByName,DasUnavailableError,type GaugeRpc} from './vault-gauges';

const QUARRY='JCL1Yjzttrh853S5X3jUcwAHdoXxfTA5eFxin5aypZjo';
const MINT='4tJzyC46PrZmgifK3FTynwZ2XnzvgQRveLYhx6bWe4U5';
const OTHER_MINT='So11111111111111111111111111111111111111112';
function gauge(quarry:string,disabled=0,meister=VAULT_GAUGEMEISTER) {
 const data=new Uint8Array(73);data.set(base58Decode(meister),8);data.set(base58Decode(quarry),40);data[72]=disabled;return data;
}
function quarry(mint:string){const data=new Uint8Array(72);data.set(base58Decode(mint),40);return data;}
const b64=(data:Uint8Array)=>[Buffer.from(data).toString('base64'),'base64'];

test('gauge and quarry layouts decode at bytes 40..72',()=>{
 expect(isActiveVaultGauge(gauge(QUARRY))).toBe(true);
 expect(isActiveVaultGauge(gauge(QUARRY,1))).toBe(false);
 expect(isActiveVaultGauge(gauge(QUARRY,0,OTHER_MINT))).toBe(false);
 expect(isActiveVaultGauge(gauge(QUARRY).subarray(0,72))).toBe(false);
 expect(gaugeQuarry(gauge(QUARRY))).toBe(QUARRY);
 expect(quarryTokenMint(quarry(MINT))).toBe(MINT);
 expect(quarryTokenMint(new Uint8Array(71))).toBeUndefined();
});
test('name matching trims, ignores case and rejects empty queries',()=>{
 const entries=[{name:'  RoboRun.xyz'},{name:'Other'},{name:''}];
 expect(matchGaugesByName(entries,' roborun ')).toEqual([{name:'  RoboRun.xyz'}]);
 expect(matchGaugesByName(entries,'zzz')).toEqual([]);
 expect(()=>matchGaugesByName(entries,'  ')).toThrow();
});
function fakeRpc(das:boolean|'nulls'):GaugeRpc {
 return (async (method:string,params:any)=>{
  if(method==='getProgramAccounts') return [
   {pubkey:'G1',account:{data:b64(gauge(QUARRY))}},
   {pubkey:'G2',account:{data:b64(gauge(OTHER_MINT,1))}},
  ];
  if(method==='getMultipleAccounts') return {value:params[0].map((q:string)=>q===QUARRY?{data:b64(quarry(MINT))}:null)};
  if(method==='getAssetBatch') { if(!das) throw new Error('method not found'); if(das==='nulls') return params.ids.map(()=>null); return params.ids.map((id:string)=>({id,content:{metadata:{name:' RoboRun.xyz'}}})); }
  throw new Error(`unexpected ${method}`);
 }) as GaugeRpc;
}
test('finds active gauges by token metadata name without network',async()=>{
 const result=await findVaultGaugesByName(fakeRpc(true),'ROBORUN');
 expect(result).toEqual({activeGauges:1,unresolvedGauges:0,matches:[{gauge:'G1',quarry:QUARRY,tokenMint:MINT,name:'RoboRun.xyz'}]});
});
test('an RPC without DAS is an explicit error, not an empty match',async()=>{
 await expect(findVaultGaugesByName(fakeRpc(false),'robo')).rejects.toBeInstanceOf(DasUnavailableError);
 await expect(findVaultGaugesByName(fakeRpc('nulls'),'robo')).rejects.toBeInstanceOf(DasUnavailableError);
});
test('partial DAS coverage is reported, and an empty match on it is an error',async()=>{
 const partial=(async (method:string,params:any)=>{
  if(method==='getProgramAccounts') return [{pubkey:'G1',account:{data:b64(gauge(QUARRY))}},{pubkey:'G3',account:{data:b64(gauge(MINT))}}];
  if(method==='getMultipleAccounts') return {value:params[0].map((q:string)=>({data:b64(quarry(q===QUARRY?MINT:OTHER_MINT))}))};
  if(method==='getAssetBatch') return params.ids.map((id:string)=>id===MINT?{id,content:{metadata:{name:'RoboRun.xyz'}}}:null);
  throw new Error(`unexpected ${method}`);
 }) as GaugeRpc;
 expect(await findVaultGaugesByName(partial,'robo')).toMatchObject({activeGauges:2,unresolvedGauges:1,matches:[{gauge:'G1'}]});
 await expect(findVaultGaugesByName(partial,'nomatch')).rejects.toBeInstanceOf(IncompleteGaugeLookupError);
});
