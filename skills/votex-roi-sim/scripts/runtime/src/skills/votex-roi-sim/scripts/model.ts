export type Model = {
 totalVev:number; otherBids:number; totalGaugeDirectedSol:number; totalGaugeVev:number;
 matchMultiplier:number; lamportsPerStakedSol:number; solUsd:number;
};
export function simulateBids(bids:number[], model:Model) {
 for(const [key,value] of Object.entries(model)) {
  if(!Number.isFinite(value) || value<0) throw new Error(`Invalid nonnegative model input: ${key}`);
 }
 if(model.totalGaugeVev<=0 || model.solUsd<=0 || model.matchMultiplier<1) throw new Error('Gauge veV and SOL price must be positive; match multiplier must be at least 1');
 if(!bids.length || bids.some(bid=>!Number.isFinite(bid)||bid<=0)) throw new Error('Every bid must be finite and positive');
 const rows=bids.map(bidUsdc=>{
  const acquiredVev=model.totalVev*bidUsdc/(model.otherBids+bidUsdc);
  const directedSol=acquiredVev*model.totalGaugeDirectedSol/model.totalGaugeVev;
  const effectiveSol=directedSol*model.matchMultiplier;
  const revenueSol=model.lamportsPerStakedSol*effectiveSol/1e9;
  const revenueUsd=revenueSol*model.solUsd;
  const netUsd=revenueUsd-bidUsdc;
  return {bidUsdc,acquiredVev,directedSol,effectiveSol,revenueSol,revenueUsd,netUsd,roiPct:netUsd/bidUsdc*100};
 });
 if(rows.some(row=>Object.values(row).some(value=>!Number.isFinite(value)))) throw new Error('Model overflow; use smaller input values');
 return rows;
}

/** Legacy default: total lamports per directed staked SOL over an unstated period; never measured. */
export const LEGACY_LAMPORTS_PER_STAKED_SOL = 105000;

export type RevenueInputs = {
 lamportsPerStakedSol?:number; revenueLamportsPerSolEpoch?:number; holdEpochs?:number; revenueLowLamportsPerSolEpoch?:number;
};
export type Revenue =
 | {mode:'per-epoch'; lamportsPerStakedSol:number; revenueLamportsPerSolEpoch:number; holdEpochs:number; revenueLowLamportsPerSolEpoch?:number}
 | {mode:'legacy-total'; lamportsPerStakedSol:number; legacyDefault:boolean};

/** Per-epoch mode needs both rate and hold; it cannot be mixed with the legacy total. */
export function resolveRevenue(input:RevenueInputs):Revenue {
 const perEpoch=input.revenueLamportsPerSolEpoch!==undefined||input.holdEpochs!==undefined||input.revenueLowLamportsPerSolEpoch!==undefined;
 if(perEpoch&&input.lamportsPerStakedSol!==undefined) throw new Error('--lamports-per-staked-sol cannot be combined with --revenue-lamports-per-sol-epoch, --hold-epochs or --revenue-low-lamports-per-sol-epoch');
 if(!perEpoch) {
  const value=input.lamportsPerStakedSol??LEGACY_LAMPORTS_PER_STAKED_SOL;
  if(!Number.isFinite(value)||value<0) throw new Error('--lamports-per-staked-sol must be finite and nonnegative');
  return {mode:'legacy-total',lamportsPerStakedSol:value,legacyDefault:input.lamportsPerStakedSol===undefined};
 }
 const rate=input.revenueLamportsPerSolEpoch, hold=input.holdEpochs, low=input.revenueLowLamportsPerSolEpoch;
 if(rate===undefined||hold===undefined) throw new Error('--revenue-lamports-per-sol-epoch and --hold-epochs must be given together (no hold default is documented)');
 if(!Number.isFinite(rate)||rate<=0) throw new Error('--revenue-lamports-per-sol-epoch must be finite and positive');
 if(!Number.isSafeInteger(hold)||hold<=0) throw new Error('--hold-epochs must be a positive integer');
 if(low!==undefined&&(!Number.isFinite(low)||low<=0)) throw new Error('--revenue-low-lamports-per-sol-epoch must be finite and positive');
 const lamportsPerStakedSol=rate*hold;
 if(!Number.isFinite(lamportsPerStakedSol)) throw new Error('Revenue overflow; use smaller input values');
 return {mode:'per-epoch',lamportsPerStakedSol,revenueLamportsPerSolEpoch:rate,holdEpochs:hold,...(low===undefined?{}:{revenueLowLamportsPerSolEpoch:low})};
}

export type Scenario = {key:string; label:string; revenueLamportsPerSolEpoch:number; effectiveEpochs:number; lamportsPerStakedSol:number; assumesLag:boolean};

/** Sensitivity scenarios for per-epoch mode: one fewer earning epoch (unverified lag) and an optional low rate. */
export function revenueScenarios(revenue:Revenue):Scenario[] {
 if(revenue.mode!=='per-epoch') return [];
 const scenarios:Scenario[]=[];
 const add=(key:string,label:string,rate:number,epochs:number,assumesLag:boolean)=>{
  if(epochs>0) scenarios.push({key,label,revenueLamportsPerSolEpoch:rate,effectiveEpochs:epochs,lamportsPerStakedSol:rate*epochs,assumesLag});
 };
 const {revenueLamportsPerSolEpoch:rate,holdEpochs:hold,revenueLowLamportsPerSolEpoch:low}=revenue;
 add('lag',`hold-1 (${hold-1} epochs, unverified activation lag)`,rate,hold-1,true);
 if(low!==undefined) {
  add('low',`low rate (${low} × ${hold})`,low,hold,false);
  add('low-lag',`low rate, hold-1 (${low} × ${hold-1}, unverified lag)`,low,hold-1,true);
 }
 return scenarios;
}

/** Index of the bid with the highest net USD; ties keep the first (smaller listed) bid. */
export function bestNetIndex(rows:Array<{netUsd:number}>):number {
 if(!rows.length) throw new Error('No rows');
 return rows.reduce((best,row,i)=>row.netUsd>rows[best].netUsd?i:best,0);
}
