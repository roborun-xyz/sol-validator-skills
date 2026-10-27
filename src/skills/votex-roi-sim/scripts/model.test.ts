import {test,expect} from 'bun:test';
import {simulateBids,type Model} from './model';
const model:Model={totalVev:1000,otherBids:100,totalGaugeDirectedSol:10000,totalGaugeVev:2000,matchMultiplier:1,lamportsPerStakedSol:100000,solUsd:100};
test('bid dilution and net cost are reflected independently',()=>{
 const [a,b]=simulateBids([100,300],model);
 expect(a.acquiredVev).toBe(500);expect(a.directedSol).toBe(2500);expect(a.revenueUsd).toBe(25);expect(a.netUsd).toBe(-75);expect(a.roiPct).toBe(-75);
 expect(b.acquiredVev).toBe(750);expect(b.directedSol).toBe(3750);
});
test('zero denominators, bad bids, negative inputs and overflow fail instead of JSON null',()=>{
 for(const patch of [{totalGaugeVev:0},{otherBids:-1},{solUsd:0},{matchMultiplier:0.5},{totalVev:Infinity},{totalVev:1e308,totalGaugeDirectedSol:1e308}]) expect(()=>simulateBids([100],{...model,...patch})).toThrow();
 for(const bids of [[],[0],[100,NaN],[-1]]) expect(()=>simulateBids(bids,model)).toThrow();
 expect(simulateBids([100],{...model,totalVev:0})[0].roiPct).toBe(-100);
});
import {resolveRevenue,revenueScenarios,bestNetIndex,LEGACY_LAMPORTS_PER_STAKED_SOL} from './model';
test('per-epoch revenue multiplies the gross rate by Solana hold epochs',()=>{
 const revenue=resolveRevenue({revenueLamportsPerSolEpoch:24014,holdEpochs:7});
 expect(revenue).toEqual({mode:'per-epoch',lamportsPerStakedSol:168098,revenueLamportsPerSolEpoch:24014,holdEpochs:7});
 const rows=simulateBids([100],{...model,lamportsPerStakedSol:revenue.lamportsPerStakedSol});
 expect(rows[0].revenueSol).toBeCloseTo(2500*168098/1e9,12);
});
test('legacy total stays available and its built-in default is flagged',()=>{
 expect(resolveRevenue({})).toEqual({mode:'legacy-total',lamportsPerStakedSol:LEGACY_LAMPORTS_PER_STAKED_SOL,legacyDefault:true});
 expect(resolveRevenue({lamportsPerStakedSol:90000})).toEqual({mode:'legacy-total',lamportsPerStakedSol:90000,legacyDefault:false});
 expect(revenueScenarios(resolveRevenue({}))).toEqual([]);
});
test('revenue modes cannot be mixed and per-epoch inputs are validated',()=>{
 expect(()=>resolveRevenue({lamportsPerStakedSol:1,revenueLamportsPerSolEpoch:1,holdEpochs:1})).toThrow(/cannot be combined/);
 expect(()=>resolveRevenue({lamportsPerStakedSol:1,holdEpochs:7})).toThrow(/cannot be combined/);
 expect(()=>resolveRevenue({revenueLamportsPerSolEpoch:24014})).toThrow(/together/);
 expect(()=>resolveRevenue({holdEpochs:7})).toThrow(/together/);
 expect(()=>resolveRevenue({revenueLowLamportsPerSolEpoch:1})).toThrow(/together/);
 for(const holdEpochs of [0,1.5,-1,NaN,Infinity]) expect(()=>resolveRevenue({revenueLamportsPerSolEpoch:1,holdEpochs})).toThrow(/positive integer/);
 for(const rate of [0,-1,NaN,Infinity]) expect(()=>resolveRevenue({revenueLamportsPerSolEpoch:rate,holdEpochs:7})).toThrow(/positive/);
 expect(()=>resolveRevenue({revenueLamportsPerSolEpoch:1,holdEpochs:7,revenueLowLamportsPerSolEpoch:0})).toThrow(/low/);
});
test('sensitivity adds an unverified hold-1 lag and an optional low rate',()=>{
 const scenarios=revenueScenarios(resolveRevenue({revenueLamportsPerSolEpoch:24014,holdEpochs:7,revenueLowLamportsPerSolEpoch:15611}));
 expect(scenarios.map(s=>[s.key,s.effectiveEpochs,s.lamportsPerStakedSol,s.assumesLag])).toEqual([
  ['lag',6,144084,true],['low',7,109277,false],['low-lag',6,93666,true],
 ]);
 expect(revenueScenarios(resolveRevenue({revenueLamportsPerSolEpoch:10,holdEpochs:1})).length).toBe(0);
});
test('best net picks the highest net USD, not the highest ROI',()=>{
 const rows=simulateBids([10,20,50,100],{...model,otherBids:1000,lamportsPerStakedSol:2_205_000});
 const best=bestNetIndex(rows);
 expect(rows.every(row=>row.netUsd<=rows[best].netUsd)).toBe(true);
 expect(rows[0].roiPct).toBeGreaterThan(rows[best].roiPct);
 expect(best).toBe(2);
 expect(bestNetIndex([{netUsd:5},{netUsd:5}])).toBe(0);
 expect(()=>bestNetIndex([])).toThrow();
});
