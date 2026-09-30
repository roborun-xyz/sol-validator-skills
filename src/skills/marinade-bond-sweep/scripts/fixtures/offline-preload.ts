// Subprocess-only fixture. All requests and child processes are intercepted.
import { readFileSync } from "node:fs";
import { selectRpc, rpcOptions, validateConfig } from "../../../shared/operator-config";
const mode = process.env.SWEEP_FIXTURE_MODE;
const identity = "fixture-identity";
const vote = "fixture-vote";
const providerError = `Provider rejected ${process.env.SOLANA_RPC_URL}; credential TEST_ONLY`;

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  if (mode === "transport-error") throw new Error(providerError);
  if (mode === "rpc-error") return Response.json({ error: { code: -32005, message: providerError } });
  const request = JSON.parse(String(init?.body));
  if (request.method !== "getBalance") throw new Error("Unexpected offline RPC request");
  return Response.json({ jsonrpc: "2.0", id: 1, result: { value: 1_000_000 } });
}) as typeof fetch;

Bun.spawn = ((command: string[], options?: {env?: Record<string, string | undefined>}) => {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  if (command[1]?.endsWith("/plan.ts")) {
    // Deliberately model an older planner to test the executor's own preflight.
    const safePlan = mode === "safe-plan" || mode === "planner-rpc-check";
    const balance = safePlan ? 5_000_000_000n : 4_000_000_000n;
    if (mode === "planner-rpc-check") {
      const environment = options?.env ?? {};
      const config = validateConfig(JSON.parse(readFileSync(environment.VALIDATOR_OPS_CONFIG!, "utf8")));
      const selected = selectRpc(rpcOptions(command.slice(2)), config, environment);
      if (selected.rpcUrl !== process.env.SWEEP_EXPECT_RPC) throw new Error("Planner used a different endpoint than the executor");
    }
    stdout = JSON.stringify({
      voteAccount: vote, identityAccount: identity,
      identityBalanceLamports: String(balance), voteBalanceLamports: "2000000000",
      voteRentExemptLamports: "27000000", voteTransferLamports: "1973000000",
      identityTransferLamports: "0", projectedIdentityAfterVoteLamports: String(balance + 1_973_000_000n),
      bondFundLamports: "1973000000", expectedFinalIdentityLamports: String(balance),
      voteAction: "withdraw-all", identityAction: safePlan ? "no-op-at-target" : "skip-below-threshold",
    });
  } else if (command[0] === "solana-keygen") {
    stdout = command[2].endsWith("/identity.fixture") ? identity
      : command[2].endsWith("/withdrawer.fixture") ? "fixture-withdrawer" : "fixture-fee-payer";
  } else if (command[0] === "validator-bonds" && command.includes("show-bond")) {
    if (mode === "cli-error") {
      stderr = providerError;
      exitCode = 1;
    } else {
      stdout = JSON.stringify({
        programId: "vBoNdEvzMrSai7is21XgVYik65mqtaKXuSdMBJ1xkW4", publicKey: "fixture-bond",
        account: { voteAccount: vote, authority: identity },
        voteAccount: { nodePubkey: identity, authorizedWithdrawer: "fixture-withdrawer" },
        amountOwned: "10 SOL", amountToWithdraw: "0 SOL", withdrawRequest: "<NOT EXISTING>",
      });
    }
  } else if (command[0] === "validator-bonds" && command.includes("--version")) stdout = "2.6.0";
  else if (command[0] === "validator-bonds" && command.includes("--help")) stdout = "--simulate --confirmation-finality --amount --from";
  else {
    process.stderr.write("UNEXPECTED_MUTATION_ATTEMPT\n");
    throw new Error("Offline fixture blocked a mutation or unknown child process");
  }
  return { stdout: new Response(stdout).body, stderr: new Response(stderr).body, exited: Promise.resolve(exitCode) };
}) as typeof Bun.spawn;

export {};
