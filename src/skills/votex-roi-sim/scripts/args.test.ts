import {test,expect} from 'bun:test';
import {parseSimulateArgs,UsageError} from './args';
const GAUGE='82r3ParT7K6iiU7xYcAvHuWUBshu8zR6EJHqs99koWZ';
const parse=(...args:string[])=>parseSimulateArgs(args);
test('per-epoch flags produce per-epoch revenue',()=>{
 const args=parse('--gauge',GAUGE,'--bids','10,50','--revenue-lamports-per-sol-epoch','24014','--hold-epochs=7','--revenue-low-lamports-per-sol-epoch','15611');
 expect(args).toMatchObject({mode:'simulate',gauge:GAUGE,bids:[10,50],epoch:'current',matchMultiplier:1,
  revenue:{mode:'per-epoch',revenueLamportsPerSolEpoch:24014,holdEpochs:7,lamportsPerStakedSol:168098,revenueLowLamportsPerSolEpoch:15611}});
});
test('legacy flag and default remain accepted',()=>{
 expect(parse('--gauge',GAUGE)).toMatchObject({revenue:{mode:'legacy-total',lamportsPerStakedSol:105000,legacyDefault:true}});
 expect(parse('--gauge',GAUGE,'--lamports-per-staked-sol','90000')).toMatchObject({revenue:{mode:'legacy-total',lamportsPerStakedSol:90000,legacyDefault:false}});
});
test('invalid or mixed revenue arguments are usage errors',()=>{
 for(const extra of [
  ['--lamports-per-staked-sol','1','--revenue-lamports-per-sol-epoch','1','--hold-epochs','7'],
  ['--revenue-lamports-per-sol-epoch','24014'],
  ['--hold-epochs','7'],
  ['--revenue-lamports-per-sol-epoch','24014','--hold-epochs','6.5'],
  ['--revenue-lamports-per-sol-epoch','0','--hold-epochs','7'],
  ['--revenue-lamports-per-sol-epoch','abc','--hold-epochs','7'],
  ['--revenue-low-lamports-per-sol-epoch','1'],
 ]) expect(()=>parse('--gauge',GAUGE,...extra)).toThrow(UsageError);
});
test('find-gauge is a lookup-only mode',()=>{
 expect(parse('--find-gauge','  RoboRun ')).toEqual({mode:'find-gauge',query:'RoboRun',format:'markdown'});
 expect(parse('--find-gauge','robo','--format','json','--rpc','https://example.invalid')).toMatchObject({mode:'find-gauge',format:'json'});
 expect(()=>parse('--find-gauge','robo','--gauge',GAUGE)).toThrow(/only looks up/);
 expect(()=>parse('--find-gauge','robo','--bids','10')).toThrow(UsageError);
 expect(()=>parse('--find-gauge','   ')).toThrow(UsageError);
});
test('existing validation is preserved',()=>{
 for(const args of [[],['--gauge','not-a-key'],['--gauge',GAUGE,'--bids','10,0'],['--gauge',GAUGE,'--bids','10,'],['--gauge',GAUGE,'--epoch','x'],
  ['--gauge',GAUGE,'--gauge',GAUGE],['--gauge',GAUGE,'--unknown','1'],['--gauge',GAUGE,'--format','csv'],['--gauge'],['--gauge',GAUGE,'--sol-usd','-1']])
  expect(()=>parse(...args)).toThrow(UsageError);
 expect(parse('--help')).toBe('help');
});
