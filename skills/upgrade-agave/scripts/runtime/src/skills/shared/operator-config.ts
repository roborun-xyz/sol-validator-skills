import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fetchResponse, TransportError } from './http';
import { base58Decode } from './base58';

export type Profile = {
  cluster: 'mainnet-beta'; voteAccount: string; identity: string; rpcUrl?: string; rpcEnv?: string;
  verification: { source: 'rpc' | 'helius-rpc'; checkedAt: string };
};
export type Config = { version: 1 | 2; defaultProfile?: string; profiles: Record<string, Profile> };
export type Input = { config?: string; profile?: string; validator?: string; voteAccount?: string; rpcUrl?: string };
export type RpcCaller = (url: string, method: string, params?: unknown) => Promise<any>;
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export function isPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && base58Decode(value).length === 32;
}

export function operatorPath(path: string | undefined, envName: string, filename: string): string {
  const value = path ?? process.env[envName] ?? `${homedir()}/.config/validator-ops/${filename}`;
  if (!value.trim()) throw new Error(`Empty configuration path: ${envName}.`);
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/'))
    throw new Error('Configuration paths support ~ or ~/ only; use an absolute path for another user.');
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value);
}
export function configPath(path?: string): string {
  return operatorPath(path, 'VALIDATOR_OPS_CONFIG', 'config.json');
}
export function validateConfig(value: any): Config {
  if (![1, 2].includes(value?.version) || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles))
    throw new Error('Invalid operator config: expected version 1 or 2 and profiles object.');
  if (Object.keys(value).some(k => !['version', 'defaultProfile', 'profiles'].includes(k))) throw new Error('Unknown operator config field.');
  for (const [name, p] of Object.entries(value.profiles) as [string, any][]) {
    if (['__proto__','constructor','prototype'].includes(name) || !/^[a-zA-Z0-9_-]+$/.test(name) || p?.cluster !== 'mainnet-beta' || !isPublicKey(p.voteAccount) || !isPublicKey(p.identity)
      || (p.rpcEnv !== undefined && (value.version !== 1 || typeof p.rpcEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(p.rpcEnv))) || (p.rpcUrl === undefined && p.rpcEnv === undefined) || !['rpc', 'helius-rpc'].includes(p.verification?.source) || typeof p.verification?.checkedAt !== 'string' || !Number.isFinite(Date.parse(p.verification?.checkedAt)))
      throw new Error('Invalid operator profile: check name, network, public keys, RPC configuration and verification.');
    if (Object.keys(p).some(k => !['cluster','voteAccount','identity','rpcUrl','rpcEnv','verification'].includes(k)) || Object.keys(p.verification).some(k => !['source','checkedAt'].includes(k))) throw new Error('Unknown profile field.');
    if (p.rpcUrl !== undefined) { if (typeof p.rpcUrl !== 'string' || !p.rpcUrl.trim()) throw new Error('Invalid saved RPC URL.'); mainnetRpcUrl(p.rpcUrl); }
  }
  if (value.defaultProfile !== undefined && (typeof value.defaultProfile !== 'string' || !Object.hasOwn(value.profiles, value.defaultProfile)))
    throw new Error('Default profile does not exist.');
  return value;
}
export async function readConfig(path?: string): Promise<Config> {
  try { return validateConfig(JSON.parse(await readFile(configPath(path), 'utf8'))); }
  catch (e: any) {
    if (e.code === 'ENOENT' && !path && !process.env.VALIDATOR_OPS_CONFIG) return { version: 2, profiles: {} };
    if (e.code === 'ENOENT') throw new Error('Specified operator config does not exist.');
    if (e instanceof SyntaxError) throw new Error('Operator config is not valid JSON.');
    throw e;
  }
}
export async function saveConfig(config: Config, path?: string) {
  validateConfig(config);
  // Legacy references remain until explicitly migrated; all new profiles persist RPC URLs.
  // Never serialize signer material or unknown fields.
  const clean: Config = { version: Object.values(config.profiles).some(p => p.rpcEnv) ? 1 : 2, profiles: {}, ...(config.defaultProfile ? {defaultProfile: config.defaultProfile} : {}) };
  for (const [name, p] of Object.entries(config.profiles)) clean.profiles[name] = {
    cluster: p.cluster, voteAccount: p.voteAccount, identity: p.identity, ...(p.rpcEnv ? {rpcEnv: p.rpcEnv} : {}), ...(p.rpcUrl ? {rpcUrl: p.rpcUrl} : {}),
    verification: { source: p.verification.source, checkedAt: p.verification.checkedAt },
  };
  const target = configPath(path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, target); }
  finally { await unlink(tmp).catch(() => {}); }
}
// Any http or https endpoint is accepted; the mainnet genesis hash is checked
// before a profile is saved and by mutation preflights. Plain http is for RPC
// nodes on a network the operator controls.
export function mainnetRpcUrl(url?: string): string {
  if (!url) throw new Error('ONBOARDING_REQUIRED: provide --rpc, set SOLANA_RPC_URL, or save an RPC URL through onboarding.');
  let u: URL; try { u = new URL(url); } catch { throw new Error('Invalid RPC URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Mainnet RPC must be an http or https URL.');
  return url;
}
function selectProfile(input: Input, config: Config) {
  const names = Object.keys(config.profiles);
  const name = input.profile ?? config.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
  if (name && !Object.hasOwn(config.profiles, name)) throw new Error('Unknown operator profile.');
  return {name, names, profile: name ? config.profiles[name] : undefined};
}
export function selectInput(input: Input, config: Config, env = process.env) {
  if (input.validator && input.voteAccount) throw new Error('Use either --validator or --vote-account, not both.');
  const explicit = input.voteAccount ?? input.validator;
  const {profile: p, names} = selectProfile(input, config);
  if (!explicit && !p) {
    throw new Error(names.length ? `PROFILE_REQUIRED: choose --profile (${names.join(', ')}).` : 'ONBOARDING_REQUIRED: provide a validator or create a validator profile.');
  }
  const target = explicit ?? p?.voteAccount;
  if (!target || !isPublicKey(target)) throw new Error('Invalid validator public key.');
  const rpc = selectRpc(input, config, env);
  return { target, ...rpc, profile: p, explicit: Boolean(explicit) };
}
// RPC selection does not change the explicit validator/claimant target.
export function selectRpc(input: Input, config: Config, env = process.env) {
  const {name, profile, names} = selectProfile(input, config);
  const nonempty = (value?: string) => value?.trim() || undefined;
  const explicit = nonempty(input.rpcUrl);
  // Version 1 retains its custom variable reference until explicit migration.
  const environment = nonempty(env[profile?.rpcEnv ?? 'SOLANA_RPC_URL']);
  if (!explicit && !environment && !name && names.length > 1)
    throw new Error(`PROFILE_REQUIRED: choose --profile (${names.join(', ')}).`);
  const source = explicit ? 'cli' : environment ? 'env' : 'config';
  return {rpcUrl: mainnetRpcUrl(explicit ?? environment ?? profile?.rpcUrl), rpcSource: source};
}
export async function resolveRpc(input: Input = {}) {
  return selectRpc(input, await readConfig(input.config));
}
// Common options for RPC-only helpers, supporting both --option VALUE and --option=VALUE.
export function rpcOptions(args: string[]): Input {
  const input: Input = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, ...inline] = args[i].split('=');
    if (!['--rpc', '--config', '--profile'].includes(flag)) continue;
    const value = inline.length ? inline.join('=') : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    const key = flag === '--rpc' ? 'rpcUrl' : flag === '--config' ? 'config' : 'profile';
    if (input[key] !== undefined) throw new Error('Duplicate RPC selection option.');
    input[key] = value;
  }
  return input;
}
/** One lazy RPC selection per command, shared by requests, redaction and child processes. */
export function createRpcContext(input: () => Input = () => rpcOptions(process.argv.slice(2))) {
  let pending: Promise<string> | undefined;
  let resolved: string | undefined;
  let selectedPath: string | undefined;
  const url = () => pending ??= (async () => {
    const options = input();
    // A missing default file is allowed. Do not turn it into an explicit missing file in children.
    selectedPath = options.config !== undefined || process.env.VALIDATOR_OPS_CONFIG !== undefined ? configPath(options.config) : undefined;
    resolved = (await resolveRpc(options)).rpcUrl;
    return resolved;
  })();
  return {
    url,
    rpc: async <T = any>(method: string, params: unknown = []) => rpcCall<T>(await url(), method, params),
    redact: (value: string) => redactRpc(value, resolved ?? process.env.SOLANA_RPC_URL),
    // Forward the selected endpoint and explicit operator file. Legacy-aware children
    // also receive --rpc so a custom v1 variable cannot override this endpoint.
    environment: async () => ({...process.env, SOLANA_RPC_URL:await url(), VALIDATOR_OPS_CONFIG:selectedPath}),
  };
}
export function redactRpc(value: string, url?: string): string {
  if (url) {
    value = value.replaceAll(url, '<RPC>');
    try { for (const key of new URL(url).searchParams.values()) if (key) value = value.replaceAll(key, '<KEY>').replaceAll(encodeURIComponent(key), '<KEY>'); } catch {}
  }
  return value.replace(/https?:\/\/[^\s"'\\<>]+/gi, '<RPC>');
}
/** SDKs must not include failing provider response bodies in diagnostics. */
export async function fetchRpcResponse(url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  try {
    const response = await fetchResponse(url, init);
    if (!response.ok) throw new Error();
    return response;
  } catch { throw new TransportError('RPC transport failed; URL omitted.'); }
}
export async function rpcCall<T = any>(url: string, method: string, params: unknown = []): Promise<T> {
  try {
    const response = await fetchRpcResponse(url, { method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc:'2.0', id:1, method, params}) });
    const body: any = await response.json();
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error();
    return body.result;
  } catch { throw new TransportError(`RPC ${method} failed; check connectivity and credentials (URL omitted).`); }
}
export async function verifyValidator(target: string, url: string, call: RpcCaller = rpcCall) {
  if (await call(url, 'getGenesisHash') !== MAINNET_GENESIS) throw new Error('RPC network mismatch: expected Solana mainnet-beta.');
  const accounts = await call(url, 'getVoteAccounts', [{commitment:'finalized'}]);
  if (!Array.isArray(accounts?.current) || !Array.isArray(accounts?.delinquent)) throw new Error('Invalid RPC vote-account response.');
  const matches = [...accounts.current, ...accounts.delinquent].filter((p: any) => p?.votePubkey === target || p?.nodePubkey === target);
  if (matches.length === 0) {
    // getVoteAccounts excludes some zero-stake accounts; a valid vote account
    // still supplies an authoritative identity for historical read-only queries.
    const result = await call(url, 'getAccountInfo', [target, {encoding:'jsonParsed',commitment:'finalized'}]);
    const account = result?.value;
    const identity = account?.data?.parsed?.info?.nodePubkey;
    if (account?.owner === 'Vote111111111111111111111111111111111111111' && account?.data?.parsed?.type === 'vote' && isPublicKey(identity)) return {voteAccount:target,identity};
    throw new Error('Validator missing on mainnet; supply an existing vote account for historical queries.');
  }
  if (matches.length !== 1) throw new Error('Validator ambiguous on mainnet; supply its vote account.');
  if (!isPublicKey(matches[0].votePubkey) || !isPublicKey(matches[0].nodePubkey)) throw new Error('Invalid RPC validator public keys.');
  return { voteAccount: matches[0].votePubkey as string, identity: matches[0].nodePubkey as string };
}
export async function resolveOperator(input: Input, call: RpcCaller = rpcCall) {
  const selected = selectInput(input, await readConfig(input.config));
  const live = await verifyValidator(selected.target, selected.rpcUrl, call);
  if (selected.profile && !selected.explicit && live.identity !== selected.profile.identity)
    throw new Error('PROFILE_CONFLICT: live identity changed; refresh the validator profile before continuing.');
  return { ...live, rpcUrl: selected.rpcUrl };
}
