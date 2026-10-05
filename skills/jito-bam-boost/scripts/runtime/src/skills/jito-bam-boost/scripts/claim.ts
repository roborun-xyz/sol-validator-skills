#!/usr/bin/env bun

import { localIso } from "../../shared/time";

import { createRpcContext, rpcOptions } from "../../shared/operator-config.ts";
import { BAM_BOOST_PROGRAM } from "../../shared/bam-accounts";
import { lamportsToSol } from "../../shared/amounts";
import { pollReadOnly } from "../../shared/poll";

import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkBamBoost } from "./check.ts";

const OFFICIAL_REPO = "https://github.com/jito-foundation/jito-bam-boost-cli.git";
const PINNED_COMMIT = "1fbca8059eb13f6120b12b8b77d51dfb1013a2d6";
const BAM_PROGRAM = BAM_BOOST_PROGRAM.toBase58();
const rpcContext = createRpcContext();
const MIN_IDENTITY_BALANCE_LAMPORTS = 10_000_000n;

type Options = {
  identity: string;
  claimEpoch: number;
  expectedAmountLamports: bigint;
  keypair: string;
  cliDir?: string;
  execute: boolean;
};

async function run(
  command: string[],
  options: { cwd?: string; stream?: boolean; env?: Record<string, string> } = {},
) {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...await rpcContext.environment(), ...options.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (options.stream) {
    if (stdout) process.stdout.write(rpcContext.redact(stdout));
    if (stderr) process.stderr.write(rpcContext.redact(stderr));
  }
  if (exitCode !== 0) {
    const details = rpcContext.redact(stderr.trim() || stdout.trim());
    throw new Error(
      `${command[0]} exited with ${exitCode}: ${details}`,
    );
  }
  return { stdout, stderr };
}

async function ensureOfficialCli(requestedDir?: string): Promise<string> {
  const cliDir = requestedDir
    ? resolve(requestedDir)
    : join(
        homedir(),
        ".cache",
        "validator-ops",
        "jito-bam-boost-cli",
        PINNED_COMMIT,
      );
  let exists = false;
  try {
    exists = (await stat(join(cliDir, ".git"))).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    if (requestedDir) {
      throw new Error(`--cli-dir is not an existing git checkout: ${cliDir}`);
    }
    await mkdir(resolve(cliDir, ".."), { recursive: true });
    // Clone and pin in a staging directory so an interrupted setup never leaves
    // an unpinned checkout at the cache path.
    const staging = `${cliDir}.staging-${process.pid}`;
    try {
      await run(["git", "clone", "--filter=blob:none", OFFICIAL_REPO, staging], {
        stream: true,
      });
      await run(["git", "checkout", "--detach", PINNED_COMMIT], {
        cwd: staging,
        stream: true,
      });
      await rename(staging, cliDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  const origin = (
    await run(["git", "remote", "get-url", "origin"], { cwd: cliDir })
  ).stdout.trim();
  if (
    origin !== OFFICIAL_REPO &&
    origin !== OFFICIAL_REPO.replace(/\.git$/, "")
  ) {
    throw new Error(`Official CLI checkout has unexpected origin: ${origin}`);
  }
  const head = (
    await run(["git", "rev-parse", "HEAD"], { cwd: cliDir })
  ).stdout.trim();
  if (head !== PINNED_COMMIT) {
    throw new Error(
      `Official CLI checkout ${cliDir} is at ${head}; expected pinned commit ${PINNED_COMMIT}. Remove or replace that checkout and rerun`,
    );
  }
  const dirty = (await run(["git", "status", "--porcelain", "--untracked-files=all"], {cwd: cliDir})).stdout.trim();
  if (dirty) throw new Error("Official CLI checkout contains local changes; use a clean pinned checkout");
  await access(join(cliDir, "Cargo.lock"), constants.R_OK);
  await run(
    ["cargo", "build", "--release", "--locked", "-p", "jito-bam-boost-cli"],
    { cwd: cliDir, stream: true },
  );
  const binary = join(cliDir, "target", "release", "jito-bam-boost-cli");
  await access(binary, constants.X_OK);
  return binary;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: bun scripts/claim.ts --identity PUBKEY --claim-epoch N --expected-amount-lamports N --keypair PATH --execute [--cli-dir PATH]\nRPC: --rpc, SOLANA_RPC_URL, or saved profile; --config and --profile select configuration. Submits a mainnet claim only with --execute.");
    process.exit(0);
  }
  let identity = "";
  let claimEpoch: number | undefined;
  let expectedAmountLamports: bigint | undefined;
  let keypair = "";
  let cliDir: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--identity" && next) {
      identity = next;
      index++;
    } else if (arg === "--claim-epoch" && next && /^\d+$/.test(next)) {
      claimEpoch = Number(next);
      index++;
    } else if (
      arg === "--expected-amount-lamports" &&
      next &&
      /^\d+$/.test(next)
    ) {
      expectedAmountLamports = BigInt(next);
      index++;
    } else if (arg === "--keypair" && next) {
      keypair = resolve(next);
      index++;
    } else if (arg === "--cli-dir" && next) {
      cliDir = resolve(next);
      index++;
    } else if (["--rpc", "--config", "--profile"].includes(arg) && next && !next.startsWith("--")) {
      index++;
    } else if (arg === "--execute") {
      execute = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (
    !identity ||
    claimEpoch === undefined ||
    !Number.isSafeInteger(claimEpoch) ||
    expectedAmountLamports === undefined ||
    !keypair ||
    !execute
  ) {
    throw new Error(
      "Required: --identity, --claim-epoch, --expected-amount-lamports, --keypair, and --execute",
    );
  }
  return {
    identity,
    claimEpoch,
    expectedAmountLamports,
    keypair,
    cliDir,
    execute,
  };
}

function extractSignature(output: string): string | null {
  const match = output.match(
    /Transaction confirmed:\s*(?:Signature\()?['\"]?([1-9A-HJ-NP-Za-km-z]{64,90})/,
  );
  return match?.[1] ?? null;
}

try {
  const options = parseOptions();
  const rpcUrl = await rpcContext.url(); // Fail before reading signers or building the external CLI.
  const checkOptions = {
    ...rpcOptions(process.argv.slice(2)),
    identity: options.identity,
    claimEpoch: options.claimEpoch,
    rpcUrl,
  };
  await access(options.keypair, constants.R_OK);
  const keypairPubkey = (
    await run(["solana-keygen", "pubkey", options.keypair])
  ).stdout.trim();
  if (keypairPubkey !== options.identity) {
    throw new Error(
      `Keypair pubkey ${keypairPubkey} does not match approved identity ${options.identity}`,
    );
  }

  const binary = await ensureOfficialCli(options.cliDir);

  // Keep the finalized financial preflight immediately before submission;
  // the first Cargo build can take substantially longer than subsequent runs.
  const before = await checkBamBoost(checkOptions);
  const allocation = before.allocations.find(
    (item) => item.claimEpoch === options.claimEpoch,
  );
  if (!allocation) {
    throw new Error(`No positive BAM allocation for claim epoch ${options.claimEpoch}`);
  }
  if (allocation.status !== "claimable") {
    throw new Error(
      `Claim epoch ${options.claimEpoch} is ${allocation.status}, not claimable`,
    );
  }
  if (BigInt(allocation.amountLamports) !== options.expectedAmountLamports) {
    throw new Error(
      `Allocation changed: approved ${options.expectedAmountLamports}, finalized preflight ${allocation.amountLamports}`,
    );
  }
  if (BigInt(before.identityBalanceLamports) < MIN_IDENTITY_BALANCE_LAMPORTS) {
    throw new Error(
      `Identity balance ${before.identityBalanceLamports} lamports is below the 0.01 SOL execution floor`,
    );
  }

  const command = [
    binary,
    "--rpc-url",
    rpcUrl,
    "--commitment",
    "finalized",
    "--signer",
    options.keypair,
    "--jito-bam-boost-program-id",
    BAM_PROGRAM,
    "bam-boost",
    "merkle-distributor",
    "claim",
    "--network",
    "mainnet",
    "--epoch",
    String(options.claimEpoch),
  ];
  const submitted = await run(command, {
    stream: true,
    env: { RUST_LOG: "info" },
  });

  // The CLI can return before every node serves the finalized Claim Status.
  // Poll read-only within a fixed bound; this never resubmits.
  const after = await pollReadOnly(async () => {
    const result = await checkBamBoost(checkOptions);
    const verified = result.allocations.find(
      (item) => item.claimEpoch === options.claimEpoch,
    );
    return verified?.status === "claimed" ? result : undefined;
  }, 10, 3_000);
  if (!after) {
    throw new Error(
      "Transaction returned success, but finalized Claim Status verification did not show claimed",
    );
  }
  const beforeToken = BigInt(before.destinationJitoSolBalanceLamports);
  const afterToken = BigInt(after.destinationJitoSolBalanceLamports);
  const delta = afterToken - beforeToken;
  if (delta !== options.expectedAmountLamports) {
    throw new Error(
      `Finalized JitoSOL balance delta ${delta} does not equal approved amount ${options.expectedAmountLamports}; do not retry`,
    );
  }

  const completedAt = new Date();
  const combinedOutput = `${submitted.stdout}\n${submitted.stderr}`;
  console.log(
    JSON.stringify(
      {
        status: "claimed",
        completedAtUtc: completedAt.toISOString(),
        completedAtLocal: localIso(completedAt),
        identity: options.identity,
        claimEpoch: options.claimEpoch,
        amountLamports: options.expectedAmountLamports.toString(),
        amountJitoSol: lamportsToSol(options.expectedAmountLamports),
        solEquivalentAtCheck: allocation.solEquivalent,
        transactionSignature: extractSignature(combinedOutput),
        distributor: allocation.distributor,
        claimStatus: allocation.claimStatus,
        destinationJitoSolAccount: before.destinationJitoSolAccount,
        destinationBalanceBeforeLamports: beforeToken.toString(),
        destinationBalanceAfterLamports: afterToken.toString(),
        destinationBalanceDeltaLamports: delta.toString(),
        officialCliCommit: PINNED_COMMIT,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(rpcContext.redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
