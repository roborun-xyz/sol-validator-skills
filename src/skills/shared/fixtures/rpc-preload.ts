// Offline subprocess fixture: no request is sent to a network endpoint.
import { MAINNET_GENESIS } from '../operator-config';
globalThis.fetch=Object.assign(async (_input:Parameters<typeof fetch>[0], init?:Parameters<typeof fetch>[1])=>{
 const url=String(_input);
 if (!url.startsWith('https://mainnet.helius-rpc.com/')) {
  let payload: unknown;
  if(url.includes('validators-history/history')) payload={data:[{epoch:100,votingReward:'1000000000'}]};
  else if(url.includes('/bonds/')) payload={bonds:[]};
  else if(url.includes('/validator_rewards/') || url.includes('kobe.mainnet.jito.network/api/v1/validators')) payload=[];
  else if(url.includes('/merkle_tree.json')) return new Response('',{status:404});
  else throw new Error('Unexpected fixture HTTP endpoint');
  return new Response(JSON.stringify(payload));
 }
 const request=JSON.parse(String(init?.body));
 let result:unknown;
 if(request.method==='getGenesisHash') result=process.env.FIXTURE_WRONG_NETWORK?'testnet':MAINNET_GENESIS;
 else if(request.method==='getVoteAccounts') result={current:[{votePubkey:'So11111111111111111111111111111111111111112',nodePubkey:'11111111111111111111111111111111'}],delinquent:[]};
 else if(request.method==='getEpochInfo') result={epoch:101};
 else throw new Error('Unexpected fixture RPC method');
 return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
},{preconnect:fetch.preconnect});
