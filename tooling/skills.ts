import {readFile, readdir, lstat, mkdir, writeFile, chmod, rm} from 'node:fs/promises';
import {resolve, dirname, posix} from 'node:path';

export const root = resolve(import.meta.dir, '..');
const sourcePath = 'src/skills';
type Artifact = {bytes: Buffer; mode: number};
type Artifacts = Map<string, Artifact>;

export async function listFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (['node_modules', '.venv', '__pycache__', '.DS_Store'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in skill source: ${entry.name}`);
    if (entry.isDirectory()) output.push(...(await listFiles(resolve(directory, entry.name))).map(file => `${entry.name}/${file}`));
    else if (entry.isFile()) output.push(entry.name);
  }
  return output.sort();
}

export function validateManifest(text: string, name: string) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`Missing skill frontmatter: ${name}`);
  const data = Bun.YAML.parse(match[1]) as Record<string, unknown>;
  const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  if (!data || Object.keys(data).some(key => !allowed.has(key))) throw new Error(`Unsupported frontmatter: ${name}`);
  if (data.name !== name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024) throw new Error(`Invalid description: ${name}`);
  if (data.license !== 'MIT' || typeof data.compatibility !== 'string' || !data.compatibility || data.compatibility.length > 500) throw new Error(`Missing license/environment requirements: ${name}`);
  const metadata = data.metadata as Record<string, unknown>;
  if (!metadata || Object.values(metadata).some(value => typeof value !== 'string')) throw new Error(`Metadata must contain strings: ${name}`);
  for (const key of ['created', 'last_updated']) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(metadata[key]))) throw new Error(`Missing ${key}: ${name}`);
  return data;
}

function referenceDestination(file: string, ownInstructions: string) {
  if (file === ownInstructions) return 'SKILL.md';
  return `references/${file.replace(/\/instructions\.md$/, '.md').replaceAll('/', '-')}`;
}

// Only literal local document references are rewritten. Operator paths and URLs
// are not repository inputs and must never be copied into a distribution.
function localDoc(from: string, target: string): string | undefined {
  const path = target.split('#')[0];
  if (!path.endsWith('.md') || /^[a-z]+:/i.test(path) || path.startsWith('~') || path.startsWith('/')) return;
  const normalized = posix.normalize(posix.join(posix.dirname(from), path));
  if (normalized.startsWith('../')) throw new Error(`Document escapes skill sources: ${from} -> ${target}`);
  return normalized;
}

function docTargets(text: string): string[] {
  const links = [...text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].map(match => match[1]);
  const code = [...text.matchAll(/`((?:\.{1,2}\/|references\/)[^`\n\s]+\.md(?:#[^`\n\s]+)?)`/g)].map(match => match[1]);
  return [...links, ...code];
}

function installedRuntime(text: string): string {
  const config = text.slice(text.indexOf('## Discover operator configuration'));
  if (!config.startsWith('## Discover')) throw new Error('Runtime configuration section missing');
  const frontmatter = text.match(/^---\n[\s\S]*?\n---/)![0];
  return `${frontmatter}\n\n# Installed skill and operator configuration\n\nThis skill includes its runtime and referenced workflows. It works when copied alone by a skills hub; no sibling skill, Git checkout or private operator repository is required.\n\n## Locate execution paths\n\nResolve symlinks on the absolute path of the loaded SKILL.md and use its containing directory as SKILL_DIR. The bundled runtime is at SKILL_DIR/scripts/runtime. Verify its package.json has name sol-validator-skills.\n\n\`\`\`bash\nSKILL_DIR="$(dirname "$(realpath /absolute/installed/skill/SKILL.md)")"\nBUNDLE_ROOT="$SKILL_DIR/scripts/runtime"\ncd "$BUNDLE_ROOT"\nbun install --frozen-lockfile\n\`\`\`\n\nRun the relative commands in these instructions with the command tool's working directory set to BUNDLE_ROOT. The runtime contains the referenced src/skills scripts and shared code. Install dependencies only when a Bun command needs them. Python SFDP checks use the standard library: create a project environment with \`python3 -m venv "$BUNDLE_ROOT/.venv"\` and use \`"$BUNDLE_ROOT/.venv/bin/python"\`. Bash-only diagnostics do not need Bun or Python.\n\nResolve user-supplied relative input, output and configuration paths against the original session directory before changing working directory. Never choose configuration or credentials from an arbitrary cwd.\n\n${config}`;
}

export async function buildArtifacts(source = root): Promise<Artifacts> {
  const tree = resolve(source, sourcePath);
  const files = await listFiles(tree);
  const available = new Set(files);
  const instructions = files.filter(file => /^[^/]+\/instructions\.md$/.test(file));
  const artifacts: Artifacts = new Map();
  const add = (path: string, bytes: Buffer | string, mode = 0o644) => {
    if (artifacts.has(path)) throw new Error(`Duplicate generated file: ${path}`);
    artifacts.set(path, {bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes, mode});
  };
  for (const own of instructions) {
    const name = own.split('/')[0];
    const prefix = `skills/${name}`;
    const docs = new Map<string, string>();
    const components = new Set([name, 'shared']);
    const pending = [own];
    while (pending.length) {
      const file = pending.pop()!;
      if (docs.has(file)) continue;
      if (!available.has(file)) throw new Error(`Missing local reference: ${file}`);
      let text = await readFile(resolve(tree, file), 'utf8');
      if (file === 'shared/runtime.md') text = installedRuntime(text);
      docs.set(file, text);
      components.add(file.split('/')[0]);
      for (const match of text.matchAll(/src\/skills\/([a-z0-9-]+)\//g)) components.add(match[1]);
      for (const target of docTargets(text)) {
        const dependency = localDoc(file, target);
        if (dependency) pending.push(dependency);
      }
    }
    for (const [file, original] of docs) {
      const destination = referenceDestination(file, own);
      const rewrite = (target: string) => {
        const dependency = localDoc(file, target);
        if (!dependency) return target;
        const hash = target.includes('#') ? `#${target.split('#').slice(1).join('#')}` : '';
        return posix.relative(posix.dirname(destination), referenceDestination(dependency, own)) + hash;
      };
      let text = original.replace(/(\[[^\]\n]+\]\()([^\s)]+)(\))/g, (_, start, target, end) => `${start}${rewrite(target)}${end}`);
      text = text.replace(/`((?:\.{1,2}\/|references\/)[^`\n\s]+\.md(?:#[^`\n\s]+)?)`/g, (_, target) => `\`${rewrite(target)}\``);
      if (file === own) validateManifest(text, name);
      add(`${prefix}/${destination}`, text);
    }
    for (const file of files) {
      if (!components.has(file.split('/')[0]) || /(?:\.test\.ts$|\/tests\/|\/fixtures\/)/.test(file) || !/\.(?:ts|py|sh)$/.test(file)) continue;
      const stat = await lstat(resolve(tree, file));
      add(`${prefix}/scripts/runtime/${sourcePath}/${file}`, await readFile(resolve(tree, file)), stat.mode & 0o111 ? 0o755 : 0o644);
    }
    // Each install carries the dependency lock and license; it does not rely
    // on the source repository surviving a hub's temporary clone cleanup.
    for (const file of ['package.json', 'bun.lock']) add(`${prefix}/scripts/runtime/${file}`, await readFile(resolve(source, 'runtime', file)));
    add(`${prefix}/LICENSE`, await readFile(resolve(source, 'LICENSE')));
    const agent = `${name}/agents/openai.yaml`;
    if (available.has(agent)) add(`${prefix}/agents/openai.yaml`, await readFile(resolve(tree, agent)));
  }
  add('skills/README.md', publishedIndex(artifacts));
  return artifacts;
}

// Browsers of the generated directory see an index instead of sixteen copies
// of the shared runtime with no explanation. The dates come from the skills so
// the index only changes when a skill does.
function publishedIndex(artifacts: Artifacts): string {
  const rows: string[] = [];
  const created = '2026-10-08';
  let lastUpdated = created;
  for (const [file, artifact] of artifacts) {
    const match = file.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (!match) continue;
    const data = validateManifest(artifact.bytes.toString(), match[1]) as {description: string; metadata: {last_updated: string}};
    rows.push(`| [${match[1]}](${match[1]}/SKILL.md) | ${data.description.split(/(?<=\.)\s/)[0]} |`);
    if (data.metadata.last_updated > lastUpdated) lastUpdated = data.metadata.last_updated;
  }
  return `---
created: ${created}
last_updated: ${lastUpdated}
---

# Published skills

Generated by \`bun run skills:build\` from \`src/skills\` at the repository root. Do not edit these files; change the source and rebuild.

Each directory is one installable Agent Skill. It carries its own \`SKILL.md\`, the references it links, the runtime scripts it calls, the shared helpers those scripts import, a pinned dependency lock and the license. That is why the shared runtime appears in every directory: a hub can copy one directory on its own and nothing else is needed.

| Skill | Purpose |
|---|---|
${rows.sort().join('\n')}

Install one with \`bunx --bun skills@1.7.0 add roborun-xyz/sol-validator-skills --skill <name> --agent <agent>\`, or copy the directory into any Agent Skills client.
`;
}

export async function checkArtifacts(source = root) {
  const expected = await buildArtifacts(source);
  const actual = (await listFiles(resolve(source, 'skills'))).map(file => `skills/${file}`);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...expected.keys()].sort())) throw new Error('Generated skill file set differs; run bun run skills:build');
  for (const [file, artifact] of expected) {
    if (!(await readFile(resolve(source, file))).equals(artifact.bytes)) throw new Error(`Stale generated skill: ${file}; run bun run skills:build`);
    if (((await lstat(resolve(source, file))).mode & 0o111) !== (artifact.mode & 0o111)) throw new Error(`Incorrect executable mode: ${file}`);
  }
  return expected;
}

export async function writeArtifacts(source = root) {
  const artifacts = await buildArtifacts(source);
  const destination = resolve(source, 'skills');
  // Only the generated publication directory is replaced.
  await rm(destination, {recursive: true, force: true});
  for (const [file, artifact] of artifacts) {
    await mkdir(dirname(resolve(source, file)), {recursive: true});
    await writeFile(resolve(source, file), artifact.bytes);
    await chmod(resolve(source, file), artifact.mode);
  }
  const allowlistPath = resolve(source, 'release-files.json');
  const sourceFiles = (JSON.parse(await readFile(allowlistPath, 'utf8')) as string[]).filter(file => !file.startsWith('skills/'));
  await writeFile(allowlistPath, JSON.stringify([...sourceFiles, ...artifacts.keys()].sort(), null, 2) + '\n');
  return artifacts;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--write', '--check'].includes(args[0])) throw new Error('Usage: bun tooling/skills.ts --write | --check');
    const artifacts = args[0] === '--write' ? await writeArtifacts() : await checkArtifacts();
    console.log(`${args[0] === '--write' ? 'Built' : 'Verified'} ${artifacts.size} self-contained skill files`);
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
