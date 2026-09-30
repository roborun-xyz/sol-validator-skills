import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configPath, operatorPath, validateConfig, selectRpc, type Config } from '../../shared/operator-config';

type FileStatus = { path: string; exists: boolean | null; status: string; detail?: string };
async function inspect(path: string): Promise<FileStatus> {
  try {
    const info = await stat(path);
    return {path, exists: true, status: info.isFile() ? 'present' : 'invalid', ...(info.isFile() ? {} : {detail: 'Expected a regular file.'})};
  } catch (error: any) {
    return {path, exists: error.code === 'ENOENT' ? false : null, status: error.code === 'ENOENT' ? 'missing' : 'unreadable'};
  }
}

// Diagnostic only: never fetch RPC, SSH, write config, or print unvalidated file content.
export async function configurationStatus(config?: string, fleet?: string, hosts?: string) {
  const profiles = await inspect(configPath(config));
  const fleetFile = await inspect(operatorPath(fleet, 'VALIDATOR_OPS_FLEET', 'fleet.json'));
  const hostFile = await inspect(operatorPath(hosts, 'VALIDATOR_OPS_HOST_INVENTORY', 'hosts.md'));
  let validated: Config = {version: 1, profiles: {}};
  if (profiles.status === 'present') {
    try { validated = validateConfig(JSON.parse(await readFile(profiles.path, 'utf8'))); profiles.status = 'valid'; }
    catch { profiles.status = 'invalid'; profiles.detail = 'Cannot read or validate operator profile JSON.'; }
  }
  if (fleetFile.status === 'present') {
    const bundle = resolve(import.meta.dir, '../../../..');
    const python = resolve(bundle, '.venv/bin/python');
    try {
      const proc = Bun.spawn([python, resolve(bundle, 'src/skills/sfdp-check/scripts/check_sfdp.py'), '--fleet', fleetFile.path, '--validate-config'],
        {stdout: 'pipe', stderr: 'pipe'});
      const [output, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code === 0 && JSON.parse(output).valid === true) fleetFile.status = 'valid';
      else { fleetFile.status = 'invalid'; fleetFile.detail = 'Fleet schema validation failed; use the SFDP local validator for details.'; }
    } catch { fleetFile.status = 'unchecked'; fleetFile.detail = 'Fleet validator unavailable; initialize the bundle .venv and retry.'; }
  }
  if (hostFile.status === 'present') {
    try {
      const content = await readFile(hostFile.path, 'utf8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
      const date = /^(?:created|last_updated):\s*\d{4}-\d{2}-\d{2}\s*$/gm;
      hostFile.status = content.trim() ? 'readable' : 'invalid';
      hostFile.detail = content.trim() ? 'Markdown only; host facts and freshness require review and live preflight.' : 'Host inventory is empty.';
      if (content.trim() && new Set(frontmatter.match(date)?.map(line => line.split(':')[0])).size !== 2)
        hostFile.detail += ' Missing created/last_updated date fields.';
    } catch { hostFile.status = 'unreadable'; }
  }
  return { configPath: profiles.path, version: validated.version, defaultProfile: validated.defaultProfile,
    profiles: Object.fromEntries(Object.entries(validated.profiles).map(([name, p]) => [name, {cluster:p.cluster, identity:p.identity, voteAccount:p.voteAccount, verification:p.verification}])),
    rpcConfigured: Object.fromEntries(Object.entries(validated.profiles).map(([name, profile]) => [name, (() => { try { selectRpc({profile:name}, validated); return true; } catch { return false; } })()])),
    rpcSource: Object.fromEntries(Object.keys(validated.profiles).map(name => { try { return [name, selectRpc({profile:name}, validated).rpcSource]; } catch { return [name, 'unavailable']; } })),
    files: {profiles, fleet: fleetFile, hosts: hostFile},
    verification: 'Local configuration checks only; no network or host verification. Missing files block only workflows that need them.' };
}
