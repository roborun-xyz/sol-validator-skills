import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkArtifacts, listFiles, root} from './skills';

async function run(command: string[], cwd: string, env: Record<string, string | undefined>, timeout = 120_000) {
  const proc = Bun.spawn(command, {cwd, env, stdout: 'pipe', stderr: 'pipe'});
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${stdout}\n${stderr}`);
    return stdout + stderr;
  } finally {clearTimeout(timer);}
}

export async function installSmoke(source = root) {
  const artifacts = await checkArtifacts(source);
  const names = [...artifacts.keys()].filter(path => /^skills\/[^/]+\/SKILL.md$/.test(path)).map(path => path.split('/')[1]).sort();
  const workspace = await mkdtemp(join(tmpdir(), 'validator-skills-install-'));
  try {
    const env = {...process.env, DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', CI: '1',
      SOLANA_RPC_URL: '', VALIDATOR_OPS_CONFIG: join(workspace, 'absent-config.json'),
      VALIDATOR_OPS_FLEET: join(workspace, 'absent-fleet.json'), VALIDATOR_OPS_HOST_INVENTORY: join(workspace, 'absent-hosts.md')};
    // Project installation only; never touches user/global skills or credentials.
    await run([process.execPath, 'x', '--bun', 'skills@1.7.0', 'add', source, '--skill', '*', '--agent', 'codex', '--copy', '--yes'], workspace, env);
    const installedRoot = join(workspace, '.agents/skills');
    const installed = (await listFiles(installedRoot)).filter(path => /^[^/]+\/SKILL.md$/.test(path)).map(path => path.split('/')[0]).sort();
    if (JSON.stringify(installed) !== JSON.stringify(names)) throw new Error('skills CLI did not discover/install the expected skill set');
    let scripts = 0;
    for (const name of names) {
      const skill = join(installedRoot, name);
      const runtime = join(skill, 'scripts/runtime');
      await run([process.execPath, 'install', '--frozen-lockfile'], runtime, env);
      const runtimeFiles = await listFiles(join(runtime, 'src/skills'));
      let python = false;
      for (const path of runtimeFiles) {
        if (!path.includes('/scripts/') || !/\.(ts|py|sh)$/.test(path)) continue;
        const script = join(runtime, 'src/skills', path);
        if (!(await readFile(script, 'utf8')).startsWith('#!')) continue;
        let command: string[];
        if (path.endsWith('.py')) {
          if (!python) {await run(['python3', '-m', 'venv', '.venv'], runtime, env); python = true;}
          command = [join(runtime, '.venv/bin/python'), script, '--help'];
        } else command = [path.endsWith('.sh') ? 'bash' : process.execPath, script, '--help'];
        const output = await run(command, workspace, env, 20_000);
        if (!/usage|onboard|preflight/i.test(output)) throw new Error(`Missing CLI help: ${name}/${path}`);
        scripts++;
      }
      const status = join(runtime, 'src/skills/onboarding/scripts/onboard.ts');
      if (await Bun.file(status).exists()) {
        const result = await run([process.execPath, status, 'status'], workspace, env, 20_000);
        JSON.parse(result);
      }
      console.log(`Installed and exercised ${name}`);
    }
    return {skills: names.length, scriptHelpChecks: scripts};
  } finally {await rm(workspace, {recursive: true, force: true});}
}

if (import.meta.main) {
  installSmoke().then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message); process.exit(1);});
}
