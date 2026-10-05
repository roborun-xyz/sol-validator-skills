import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {validatePaths,auditText,inspect,exportRelease} from './release';

test('release allowlist rejects traversal, private files and duplicates',()=>{
 for(const value of [['../secret'],['/secret'],['.git/config'],['data/log'],['.env'],['.agents/skills/shared/validator-host-inventory.md'],['a','a']]) expect(()=>validatePaths(value)).toThrow();
 expect(()=>validatePaths(['README.md','tooling/release.ts'])).not.toThrow();
});
test('release scanner rejects credentials without printing their values',()=>{
 expect(auditText('script.ts','api-key='+'private-secret')).toEqual(['embedded RPC credential']);
 expect(auditText('fixture.test.ts','api-key=TEST_ONLY')).toEqual([]);
 expect(auditText('script.ts','api-key=TEST_ONLY')).toEqual(['embedded RPC credential']);
});
test('export includes only allowlisted content, refuses existing output and symlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'release-test-'));
 try {
  await writeFile(join(dir,'release-files.json'),JSON.stringify(['public.txt']));
  await writeFile(join(dir,'public.txt'),'public');
  await writeFile(join(dir,'private.txt'),'private');
  const output=join(dir,'out');await exportRelease(output,dir);
  expect(await Bun.file(join(output,'public.txt')).text()).toBe('public');
  expect(await Bun.file(join(output,'private.txt')).exists()).toBe(false);
  await expect(exportRelease(output,dir)).rejects.toThrow();
  // An invalid zone fails before the destination exists, so a corrected rerun is not refused.
  const zone=process.env.LOCAL_TIME_ZONE;const retry=join(dir,'retry');
  try {
   process.env.LOCAL_TIME_ZONE='Not/AZone';
   await expect(exportRelease(retry,dir)).rejects.toThrow('Invalid LOCAL_TIME_ZONE');
   expect(await Bun.file(join(retry,'public.txt')).exists()).toBe(false);
   process.env.LOCAL_TIME_ZONE='America/Los_Angeles';
   expect((await exportRelease(retry,dir)).createdAtLocal).toMatch(/T\d\d:\d\d:\d\d-0[78]:00$/);
  } finally {if(zone===undefined) delete process.env.LOCAL_TIME_ZONE; else process.env.LOCAL_TIME_ZONE=zone;}
  await rm(join(dir,'public.txt'));await symlink(join(dir,'private.txt'),join(dir,'public.txt'));
  await expect(inspect(dir)).rejects.toThrow('Symlink');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('Git publication audit rejects tracked files outside the reviewed allowlist', async () => {
 const dir=await mkdtemp(join(tmpdir(),'release-git-test-'));
 try {
  execFileSync('git',['init','--quiet',dir]);
  await writeFile(join(dir,'release-files.json'),JSON.stringify(['public.txt']));
  await writeFile(join(dir,'public.txt'),'public');
  await writeFile(join(dir,'unexpected.txt'),'not reviewed');
  execFileSync('git',['-C',dir,'add','public.txt','unexpected.txt']);
  await expect(inspect(dir)).rejects.toThrow('Tracked file missing from release allowlist: unexpected.txt');
 } finally {await rm(dir,{recursive:true,force:true});}
});
