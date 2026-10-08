#!/usr/bin/env bun
import { configurationStatus } from './status';
import { readConfig, saveConfig, configPath, selectInput, selectRpc, verifyValidator, type Config } from '../../shared/operator-config';
import { localIso, localTimeZone as selectedTimeZone } from '../../shared/time';

export async function main(args: string[]) {
  const command = args.shift() ?? 'status';
  if (command === '--help' || command === 'help') {
    console.log('onboard.ts status|add|refresh|migrate [--config PATH] [--profile NAME] [--validator PUBKEY] [--rpc URL] [--default]\nadd creates a new verified profile; refresh explicitly updates an existing profile. Verified RPC URLs are saved privately in operator configuration; migrate upgrades legacy references. status also accepts --fleet PATH and --hosts PATH and reports local validation only.'); return;
  }
  if (!['status','add','refresh','migrate'].includes(command)) throw new Error('Unknown onboarding command.');
  let fleet: string | undefined, hosts: string | undefined;
  let path: string | undefined, name: string | undefined, target: string | undefined, rpcUrl: string | undefined, makeDefault = false;
  for (let i=0;i<args.length;i++) {
    const flag=args[i]; if (flag === '--default') {makeDefault=true;continue;}
    if (!['--config','--fleet','--hosts','--profile','--validator','--rpc'].includes(flag)) throw new Error('Unknown onboarding option.');
    const value=args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag==='--fleet') fleet=value; else if (flag==='--hosts') hosts=value; else if (flag==='--config') path=value; else if(flag==='--profile') name=value; else if(flag==='--validator') target=value; else rpcUrl=value;
  }
  if(command==='status') { console.log(JSON.stringify(await configurationStatus(path, fleet, hosts),null,2)); return; }
  if(fleet !== undefined || hosts !== undefined) throw new Error('--fleet and --hosts apply only to status.');
  let config: Config;
  try { config=await readConfig(path); }
  catch(e) {
    if (command==='add' && (e as Error).message==='Specified operator config does not exist.') config={version:2,profiles:{}};
    else throw e;
  }
  if (command === 'migrate') {
    if (name || target || makeDefault) throw new Error('migrate accepts only --config and --rpc.');
    const next: Config = {version: 2, profiles: {}, ...(config.defaultProfile ? {defaultProfile: config.defaultProfile} : {})};
    for (const [profileName, profile] of Object.entries(config.profiles)) {
      const url = selectRpc({profile: profileName, rpcUrl:rpcUrl ?? profile.rpcUrl}, config).rpcUrl;
      const live = await verifyValidator(profile.voteAccount, url);
      if (live.identity !== profile.identity) throw new Error('PROFILE_CONFLICT: refresh identity before migration.');
      const {rpcEnv: _, ...fields} = profile;
      next.profiles[profileName] = {...fields, rpcUrl: url};
    }
    await saveConfig(next, path);
    console.log(JSON.stringify({status: 'migrated', profiles: Object.keys(next.profiles), configPath: configPath(path)}));
    return;
  }
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Provide --profile with letters, digits, hyphens or underscores.');
  const old=Object.hasOwn(config.profiles,name)?config.profiles[name]:undefined;
  if(command==='add' && !target) throw new Error('Provide --validator when adding a profile.');
  if(command==='add' && old) throw new Error('Profile already exists; use refresh to update it.');
  if(command==='refresh' && !old) throw new Error('Profile does not exist; use add first.');
  // Identity-only refresh preserves the saved endpoint despite a session override.
  const selected=selectInput({validator:target ?? old?.voteAccount, rpcUrl:rpcUrl ?? old?.rpcUrl, ...(old ? {profile:name} : {})}, config);
  const localTimeZone=selectedTimeZone(); // Reject an invalid zone before verifying or saving.
  const live=await verifyValidator(selected.target,selected.rpcUrl);
  const checkedAt=new Date().toISOString();
  const checkedAtLocal=localIso(new Date(checkedAt),localTimeZone);
  Object.defineProperty(config.profiles,name,{value:{cluster:'mainnet-beta',...live,rpcUrl:selected.rpcUrl,verification:{source:'rpc',checkedAt}},enumerable:true,writable:true,configurable:true});
  if(makeDefault) config.defaultProfile=name;
  await saveConfig(config,path);
  console.log(JSON.stringify({status:'verified',profile:name,...live,checkedAt,checkedAtLocal,localTimeZone,configPath:configPath(path)},null,2));
}
if(import.meta.main) main(Bun.argv.slice(2)).catch(e=>{console.error(e.message);process.exit(1);});
