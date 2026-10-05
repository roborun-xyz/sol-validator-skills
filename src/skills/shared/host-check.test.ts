import {test, expect} from 'bun:test';
import {mkdtemp, writeFile, chmod, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const helper = resolve(import.meta.dir, '../doublezero-status/scripts/check-doublezero-status.sh');
test('DoubleZero validates every alias before SSH and retains any host failure', async () => {
 const dir = await mkdtemp(join(tmpdir(),'dz-test-'));
 try {
  const log = join(dir,'calls');
  await writeFile(join(dir,'ssh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$SSH_TEST_LOG"\nfor arg in "$@"; do if [ "$arg" = "badhost" ]; then exit 9; fi; done\nexit 0\n');
  await chmod(join(dir,'ssh'),0o700);
  const run = async (args:string[],extra:Record<string,string>={}) => {
   const proc = Bun.spawn(['bash',helper,...args],{env:{...process.env,PATH:`${dir}:${process.env.PATH}`,SSH_TEST_LOG:log,...extra},stdout:'pipe',stderr:'pipe'});
   await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
   return proc.exited;
  };
  expect(await run(['goodhost','-oProxyCommand=bad'])).toBe(2);
  expect(await Bun.file(log).exists()).toBe(false);
  expect(await run(['badhost','goodhost'])).toBe(1);
  const calls = await readFile(log,'utf8');
  expect(calls).toContain('BatchMode=yes');
  expect(calls).toContain('-- badhost');
  expect(calls).toContain('-- goodhost');
  expect(await run(['goodhost'])).toBe(0);
  expect(await run([])).toBe(2);
  expect(await run(['--help'])).toBe(0);
  // The zone is selected like the other helpers: trimmed, blank means UTC, invalid is an error.
  await rm(log);
  expect(await run(['goodhost'],{LOCAL_TIME_ZONE:'  '})).toBe(0);
  expect(await readFile(log,'utf8')).toContain('LOCAL_TIME_ZONE=UTC bash -s');
  expect(await run(['goodhost'],{LOCAL_TIME_ZONE:' America/Los_Angeles '})).toBe(0);
  expect(await readFile(log,'utf8')).toContain('LOCAL_TIME_ZONE=America/Los_Angeles bash -s');
  expect(await run(['goodhost'],{LOCAL_TIME_ZONE:'Not/AZone'})).toBe(2);
 } finally {await rm(dir,{recursive:true,force:true});}
});
