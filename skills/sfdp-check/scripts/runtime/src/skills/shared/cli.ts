import type { Input } from './operator-config';

export type EpochQueryOptions = Input & {
  epochs: number;
  format: 'markdown' | 'csv' | 'json';
  includeCurrent: boolean;
  rpcUrl: string;
};

export const EPOCH_QUERY_HELP = `Options:
  --vote-account <pubkey>       Mainnet vote account to query
  --validator <pubkey>          Vote account or identity pubkey
  --epochs <n>                  Number of completed epochs to fetch (default: 30)
  --include-current             Include current in-progress epoch instead of only completed epochs
  --format <markdown|csv|json>  Output format (default: markdown)
  --rpc <url>                   Mainnet RPC URL (default: SOLANA_RPC_URL or saved profile URL)
  --config <path>              Local operator configuration
  --profile <name>             Configured validator profile
  --help                        Show this help text`;

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const option = args[index];
  const value = option.startsWith(`${name}=`) ? option.slice(name.length + 1) : args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

export function parseEpochQueryArgs(args: string[], help: () => never): EpochQueryOptions {
  if (args.includes('--help') || args.includes('-h')) help();
  const options: EpochQueryOptions = {epochs:30, format:'markdown', includeCurrent:false, rpcUrl:''};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--vote-account') options.voteAccount = next();
    else if (arg === '--validator') options.validator = next();
    else if (arg === '--epochs' || arg === '-n') {
      const value = Number(next());
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--epochs must be a positive integer.');
      options.epochs = value;
    } else if (arg === '--format') {
      const value = next();
      if (value !== 'markdown' && value !== 'csv' && value !== 'json') throw new Error('--format must be markdown, csv, or json.');
      options.format = value;
    } else if (arg === '--include-current') options.includeCurrent = true;
    else if (arg === '--rpc') options.rpcUrl = next();
    else if (arg === '--config') options.config = next();
    else if (arg === '--profile') options.profile = next();
    else if (!arg.startsWith('-') && !options.validator && !options.voteAccount) options.validator = arg;
    else throw new Error('Unknown argument; use --help.');
  }
  return options;
}
