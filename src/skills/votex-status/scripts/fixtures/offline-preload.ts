// All HTTP and RPC calls stay inside this subprocess fixture.
import { createHash } from "node:crypto";
import { base58Encode } from "../../../shared/base58";

const mode = process.env.VOTEX_FIXTURE_MODE;
let page = 0;

function transaction(id: number) {
  const data = Buffer.alloc(20);
  createHash("sha256").update("global:increase_vote_buy").digest().copy(data, 0, 0, 8);
  data.writeUInt32LE(100, 8);
  data.writeBigUInt64LE(id === 0 ? 100_000_000n : 50_000_000n, 12);
  return {
    slot: 123 + id, blockTime: 1_001_000 + id,
    meta: mode === "invalid-meta" ? {} : { err: mode === "failed-tx" ? { InstructionError: [0, "fixture"] } : null },
    transaction: { message: {
      accountKeys: [
        "fixture-buyer", "fixture-buyer-token", "fixture-vault",
        mode === "other-mint" && id === 1 ? "So11111111111111111111111111111111111111112" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "AAJ1TUeLfzyCrywCukTaehieCPe6bQtaNbNXpcMDLPeB", "HniSajyYDYEfdbNfW8L5Eq8W1pxt8XsYDgc6TNsx7t6x",
        "fixture-vote-buy", "fixture-gauge", "5ArmEZ9iso7p91tZafCRsfNwmoWpCG1Sd7UGbqieKBZ9",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "11111111111111111111111111111111", "VotAjwzAEF9ZLNAYEB1ivXt51911EqYGVu9NeaEKRyy",
      ],
      instructions: [{ programIdIndex: 12, accounts: Array.from({ length: 12 }, (_, index) => index), data: base58Encode(data) }],
    } },
  };
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  if (String(input).startsWith("https://raw.githubusercontent.com/")) return new Response("", { status: 404 });
  const request = JSON.parse(String(init?.body));
  if (Array.isArray(request)) {
    const responses = request.map((call: { id: number }) => ({
      jsonrpc: "2.0", id: call.id,
      ...(mode === "rpc-error" ? { error: { code: -32005, message: "fixture credential TEST_ONLY" } }
        : mode === "missing-result" ? {} : { result: mode === "null-tx" ? null : transaction(call.id) }),
    }));
    if (mode === "missing-response") responses.pop();
    if (mode === "duplicate-response") responses[1] = responses[0];
    return Response.json(responses.reverse());
  }
  let result: unknown;
  if (request.method === "getAccountInfo") {
    const data = Buffer.alloc(185);
    data.writeUInt32LE(86_400, 169);
    data.writeUInt32LE(99, 173);
    data.writeBigInt64LE(1_086_400n, 177);
    result = { value: { data: [data.toString("base64"), "base64"] } };
  } else if (request.method === "getSignaturesForAddress") {
    result = mode === "empty" || (page > 0 && mode !== "truncated") ? [] : [0, 1].map((id) => ({
      signature: `fixture-signature-${page}-${id}`, err: null, blockTime: 1_001_000 + id,
    }));
    page++;
  } else throw new Error("Unexpected offline RPC request");
  return Response.json({ jsonrpc: "2.0", id: request.id, result });
}) as typeof fetch;
