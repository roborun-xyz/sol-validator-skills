import {test, expect} from 'bun:test';
import {posix} from 'node:path';
import {buildArtifacts, validateManifest} from './skills';

test('every published skill includes its local document and runtime imports', async () => {
  const files = await buildArtifacts();
  const names = [...files.keys()].filter(file => /^skills\/[^/]+\/SKILL.md$/.test(file));
  expect(names.length).toBeGreaterThan(0);
  for (const [file, artifact] of files) {
    const text = artifact.bytes.toString();
    // The generated index links into the skills; every other file stays inside its own skill.
    const skill = file === 'skills/README.md' ? 'skills' : file.split('/').slice(0, 2).join('/');
    const targets = file.endsWith('.md')
      ? [...text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].map(match => match[1].split('#')[0]).filter(target => target && !/^[a-z]+:/i.test(target))
      : file.endsWith('.ts')
        ? [...text.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)].map(match => match[1])
        : [];
    for (const target of targets) {
      const destination = posix.normalize(posix.join(posix.dirname(file), target));
      expect(destination.startsWith(`${skill}/`)).toBe(true);
      expect([destination, `${destination}.ts`, `${destination}/index.ts`].some(path => files.has(path))).toBe(true);
    }
  }
  for (const manifest of names) {
    const name = manifest.split('/')[1];
    validateManifest(files.get(manifest)!.bytes.toString(), name);
    expect(files.has(`skills/${name}/LICENSE`)).toBe(true);
    expect(files.has(`skills/${name}/scripts/runtime/bun.lock`)).toBe(true);
    // Onboarding's Python subprocess must survive a single-skill copy too.
    if (files.has(`skills/${name}/scripts/runtime/src/skills/onboarding/scripts/status.ts`)) {
      expect(files.has(`skills/${name}/scripts/runtime/src/skills/sfdp-check/scripts/check_sfdp.py`)).toBe(true);
    }
  }
});

test('Agent Skills metadata rejects unsupported names, nonstring metadata and missing environment requirements', () => {
  const manifest = `---\nname: example\ndescription: Check an example.\nlicense: MIT\ncompatibility: Requires Bun.\nmetadata:\n  created: "2026-09-25"\n  last_updated: "2026-09-25"\n---\n\nInstructions.\n`;
  expect(() => validateManifest(manifest, 'example')).not.toThrow();
  expect(() => validateManifest(manifest, 'wrong-name')).toThrow();
  expect(() => validateManifest(manifest.replace('Requires Bun.', 'false'), 'example')).toThrow();
  expect(() => validateManifest(manifest.replace('created: "2026-09-25"', 'created: 1'), 'example')).toThrow();
});
