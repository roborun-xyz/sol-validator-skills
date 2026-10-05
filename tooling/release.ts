import {readFile, lstat, mkdir, writeFile, chmod} from 'node:fs/promises';
import {resolve, dirname, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {localIso} from '../src/skills/shared/time';

export const root = resolve(import.meta.dir, '..');
export function validatePaths(files: unknown): asserts files is string[] {
 if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || file.startsWith('/') || file.includes('\\') || file.split('/').some((part:string) => !part || part === '.' || part === '..'))) throw new Error('Invalid release allowlist paths');
 if (new Set(files).size !== files.length) throw new Error('Duplicate release path');
 for (const file of files) {
  if (file.split('/').some((part:string)=>['.git','node_modules','.venv','data','configs','__pycache__'].includes(part)) || /(?:^|\/)(?:\.env(?:\..*)?|validator-host-inventory\.md)$/.test(file)) throw new Error(`Private or generated path in release: ${file}`);
 }
}
export function auditText(file:string, text:string): string[] {
 const errors:string[]=[];
 if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) errors.push('private key material');
 const credentials = [...text.matchAll(/api-key=([A-Za-z0-9_-]+)/g)];
 if (credentials.some(match => !(file.endsWith('.test.ts') && match[1] === 'TEST_ONLY'))) errors.push('embedded RPC credential');
 if (/(?:\/Users\/[^/\s]+\/|\/Volumes\/Safe\/|\/home\/ubuntu\/)/.test(text)) errors.push('operator-specific absolute path');
 if (file.endsWith('.md')) {
  const fm=text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm || !/\bcreated: ["']?\d{4}-\d{2}-\d{2}\b/.test(fm[1]) || !/\blast_updated: ["']?\d{4}-\d{2}-\d{2}\b/.test(fm[1])) errors.push('missing Markdown creation/update dates');
 }
 return errors;
}
export async function inspect(source=root) {
 const files:unknown=JSON.parse(await readFile(resolve(source,'release-files.json'),'utf8'));
 validatePaths(files);
 // Publishing a Git repository must not bypass the export allowlist by adding
 // an unrelated tracked file. Exported trees intentionally have no .git.
 const gitMetadata = await lstat(resolve(source, '.git')).catch(() => undefined);
 if (gitMetadata) {
  const tracked = execFileSync('git', ['-C', source, 'ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
  for (const file of tracked) {
   if (!files.includes(file) && await lstat(resolve(source,file)).catch(() => undefined)) throw new Error(`Tracked file missing from release allowlist: ${file}`);
  }
 }
 const contents=new Map<string,Buffer>();
 const modes=new Map<string,number>();
 for (const file of files) {
  let current=source;
  for (const part of file.split('/')) {
   current=resolve(current,part);
   if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink in release path: ${file}`);
  }
  const stat=await lstat(current);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  const bytes=await readFile(current);
  const errors=auditText(file,bytes.toString('utf8'));
  if (errors.length) throw new Error(`${file}: ${errors.join(', ')}`);
  contents.set(file,bytes); modes.set(file,stat.mode & 0o111 ? 0o755 : 0o644);
 }
 for (const [file,bytes] of contents) {
  if (!file.endsWith('.md')) continue;
  for (const match of bytes.toString().matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
   const target=match[1].split('#')[0];
   if (!target || /^[a-z]+:/i.test(target)) continue;
   const normalized=relative(source,resolve(source,dirname(file),target)).split(sep).join('/');
   if (!contents.has(normalized)) throw new Error(`Release link target missing: ${file} -> ${target}`);
  }
 }
 return {contents,modes};
}
export async function exportRelease(output:string,source=root) {
 const {contents,modes}=await inspect(source);
 const destination=resolve(output);
 // Resolve the timestamps first: an invalid LOCAL_TIME_ZONE must fail before anything is written.
 const now=new Date();
 const created={createdAtUtc:now.toISOString(),createdAtLocal:localIso(now)};
 // Refuse an existing destination; never merge a release into private data.
 await mkdir(destination,{recursive:false,mode:0o755});
 for (const [file,bytes] of contents) {
  const path=resolve(destination,file);
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,bytes,{flag:'wx'}); await chmod(path,modes.get(file)!);
 }
 const report={...created,files:[...contents].map(([path,data])=>({path,sha256:createHash('sha256').update(data).digest('hex')}))};
 await writeFile(resolve(destination,'release-manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}
if (import.meta.main) {
 try {
  const args=process.argv.slice(2);
  if (args.length===1 && args[0]==='--check') {const {contents}=await inspect();console.log(`Release audit passed: ${contents.size} allowlisted files`);}
  else if (args.length===2 && args[0]==='--output') {const report=await exportRelease(args[1]);console.log(`Exported ${report.files.length} files to ${resolve(args[1])}`);}
  else {console.log('Usage: bun tooling/release.ts --check | --output NEW_DIRECTORY');process.exit(args.includes('--help')?0:2);}
 } catch (error) {console.error((error as Error).message);process.exit(1);}
}
