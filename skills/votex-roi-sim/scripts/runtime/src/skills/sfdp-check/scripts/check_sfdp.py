#!/usr/bin/env python3
"""Check SFDP participation and required-version compliance for configured validator pairs."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from datetime import datetime, timezone
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


API_BASE = "https://api.solana.org/api/community/v1"


@dataclass(frozen=True)
class ValidatorCheck:
    group: str
    cluster: str
    host: str
    rpc_port: int
    client: str
    expected_identity: str
    vote_account: str
    role: str


def load_fleet(path: str) -> tuple[dict[str, Any], list[ValidatorCheck]]:
    try:
        data = json.loads(Path(path).expanduser().read_text())
    except (OSError, ValueError) as exc:
        raise ValueError("ONBOARDING_REQUIRED: supply a valid local fleet JSON via --fleet or VALIDATOR_OPS_FLEET") from exc
    if not isinstance(data, dict) or (type(data.get("version")) is not int or data["version"] != 1) or set(data) != {"version", "groups", "hosts"}:
        raise ValueError("Fleet must contain version 1, groups and hosts")
    groups = data["groups"]
    if not isinstance(groups, dict) or not groups:
        raise ValueError("Fleet requires at least one SFDP group")
    def pubkey(value: Any) -> bool:
        if not isinstance(value, str) or not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", value):
            return False
        alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        number = 0
        for char in value:
            number = number * 58 + alphabet.index(char)
        return (number.bit_length() + 7) // 8 + len(value) - len(value.lstrip("1")) == 32
    for name, keys in groups.items():
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not isinstance(keys, dict) or set(keys) != {"mainnetBetaPubkey", "testnetPubkey"} or not all(pubkey(v) for v in keys.values()):
            raise ValueError("Each group needs a name and valid mainnet/testnet identity public keys")
    if not isinstance(data["hosts"], list):
        raise ValueError("hosts must be an array")
    checks = []
    seen = set()
    for host in data["hosts"]:
        if not isinstance(host, dict) or set(host) != set(ValidatorCheck.__dataclass_fields__):
            raise ValueError("Host fields do not match the fleet schema")
        item = ValidatorCheck(**host)
        if not all(isinstance(getattr(item, key), str) for key in ValidatorCheck.__dataclass_fields__ if key != "rpc_port"):
            raise ValueError("Host fields must be strings except rpc_port")
        if item.group not in groups or item.cluster not in ("mainnet-beta", "testnet") or item.client not in ("agave", "jito-agave", "firedancer"):
            raise ValueError("Invalid host group, cluster or client")
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", item.host) or type(item.rpc_port) is not int or not 1 <= item.rpc_port <= 65535:
            raise ValueError("Use a safe SSH alias and an integer RPC port")
        key = "mainnetBetaPubkey" if item.cluster == "mainnet-beta" else "testnetPubkey"
        if item.expected_identity != groups[item.group][key] or (item.vote_account and not pubkey(item.vote_account)):
            raise ValueError("Host identity must match its SFDP group; vote account must be valid or empty")
        if (item.host, item.rpc_port) in seen:
            raise ValueError("Duplicate host RPC endpoint")
        seen.add((item.host, item.rpc_port))
        checks.append(item)
    return groups, checks


def fetch_json(url: str, timeout: int) -> Any:
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"GET {url} failed: HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GET {url} failed: {exc}") from exc


def rpc_payload(method: str) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": 1, "method": method}, separators=(",", ":"))


def ssh_rpc(host: str, port: int, method: str, timeout: int) -> Any:
    payload = shlex.quote(rpc_payload(method))
    remote = (
        f"curl -sS --max-time {int(timeout)} "
        "-H 'Content-Type: application/json' "
        f"-d {payload} http://127.0.0.1:{int(port)}"
    )
    cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={int(timeout)}",
        "--",
        host,
        remote,
    ]
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 5)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"ssh exited {proc.returncode}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON from {host}:{port}: {proc.stdout[:200]}") from exc
    if "error" in data:
        raise RuntimeError(f"RPC error from {host}:{port}: {data['error']}")
    return data.get("result")


def normalize_version(version: str) -> str:
    version = version.strip()
    version = re.sub(r"^[a-zA-Z-]*v", "", version)
    return version


def split_version(version: str) -> tuple[list[int], list[str]]:
    if not isinstance(version, str):
        raise ValueError("Invalid version string")
    version = normalize_version(version).split("+", 1)[0]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?", version):
        raise ValueError("Invalid version string")
    main, sep, pre = version.partition("-")
    nums = []
    for part in main.split("."):
        match = re.match(r"(\d+)", part)
        nums.append(int(match.group(1)) if match else 0)
    pre_parts = re.split(r"[.-]", pre) if sep else []
    return nums, [p for p in pre_parts if p]


def compare_ident(a: str, b: str) -> int:
    if a.isdigit() and b.isdigit():
        return (int(a) > int(b)) - (int(a) < int(b))
    if a.isdigit():
        return -1
    if b.isdigit():
        return 1
    return (a > b) - (a < b)


def compare_versions(left: str, right: str) -> int:
    left_nums, left_pre = split_version(left)
    right_nums, right_pre = split_version(right)
    width = max(len(left_nums), len(right_nums))
    left_nums += [0] * (width - len(left_nums))
    right_nums += [0] * (width - len(right_nums))
    if left_nums != right_nums:
        return (left_nums > right_nums) - (left_nums < right_nums)
    if not left_pre and not right_pre:
        return 0
    if not left_pre:
        return 1
    if not right_pre:
        return -1
    width = max(len(left_pre), len(right_pre))
    for idx in range(width):
        if idx >= len(left_pre):
            return -1
        if idx >= len(right_pre):
            return 1
        cmp = compare_ident(left_pre[idx], right_pre[idx])
        if cmp:
            return cmp
    return 0


def client_bounds(requirement: dict[str, Any], client: str) -> tuple[str | None, str | None]:
    prefix = "firedancer" if client == "firedancer" else "agave"
    return requirement.get(f"{prefix}_min_version"), requirement.get(f"{prefix}_max_version")


def check_version(version: str, requirement: dict[str, Any], client: str) -> tuple[bool, str]:
    min_version, max_version = client_bounds(requirement, client)
    if not min_version and not max_version:
        return False, "missing client version bounds"
    failures = []
    if min_version and compare_versions(version, min_version) < 0:
        failures.append(f"< min {min_version}")
    if max_version and compare_versions(version, max_version) > 0:
        failures.append(f"> max {max_version}")
    return not failures, ", ".join(failures)


def find_participant(participants: list[dict[str, Any]], keys: dict[str, str]) -> dict[str, Any] | None:
    matches = [item for item in participants if isinstance(item, dict) and
               item.get("mainnetBetaPubkey") == keys["mainnetBetaPubkey"] and
               item.get("testnetPubkey") == keys["testnetPubkey"]]
    if len(matches) > 1:
        raise RuntimeError("Ambiguous SFDP participant pair")
    return matches[0] if matches else None


def collect(args: argparse.Namespace) -> dict[str, Any]:
    groups, configured_checks = load_fleet(args.fleet)
    if not args.api_only and not configured_checks:
        raise ValueError("No hosts configured; use --api-only or onboard a host")
    required = {}
    for cluster in ("mainnet-beta", "testnet"):
        payload = fetch_json(f"{API_BASE}/sfdp_required_versions?cluster={cluster}", args.timeout)
        if not isinstance(payload, dict):
            raise RuntimeError(f"Malformed required-version response for {cluster}")
        required[cluster] = payload.get("data", [])
    for cluster, rows in required.items():
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) or type(row.get("epoch")) is not int for row in rows):
            raise RuntimeError(f"Missing or malformed required-version rows for {cluster}")
        required[cluster] = sorted(rows, key=lambda row: row["epoch"])
    participants = fetch_json(f"{API_BASE}/sfdp_participants", args.timeout)
    if not isinstance(participants, list):
        raise RuntimeError("participants API did not return a list")

    participant_results = {}
    for group, keys in groups.items():
        participant = find_participant(participants, keys)
        participant_results[group] = {
            "found": participant is not None,
            "participant": participant,
            "approved": participant is not None and participant.get("state") == "Approved",
        }

    checks = []
    if not args.api_only:
        for item in configured_checks:
            result: dict[str, Any] = {
                "group": item.group,
                "cluster": item.cluster,
                "host": item.host,
                "rpc_port": item.rpc_port,
                "client": item.client,
                "role": item.role,
                "expected_identity": item.expected_identity,
                "vote_account": item.vote_account,
                "ok": True,
                "errors": [],
                "requirements": [],
            }
            try:
                result["health"] = ssh_rpc(item.host, item.rpc_port, "getHealth", args.timeout)
                identity = ssh_rpc(item.host, item.rpc_port, "getIdentity", args.timeout)
                version = ssh_rpc(item.host, item.rpc_port, "getVersion", args.timeout)
                result["identity"] = identity.get("identity") if isinstance(identity, dict) else None
                result["version"] = version.get("solana-core") if isinstance(version, dict) else None
                if result["identity"] != item.expected_identity:
                    result["ok"] = False
                    result["errors"].append("identity mismatch")
                if result["health"] != "ok":
                    result["ok"] = False
                    result["errors"].append(f"health={result['health']}")
                if not result["version"]:
                    result["ok"] = False
                    result["errors"].append("missing solana-core version")
                rows = required[item.cluster][:1] if args.current_only else required[item.cluster]
                for req in rows:
                    if result.get("version"):
                        passed, reason = check_version(result["version"], req, item.client)
                    else:
                        passed, reason = False, "missing version"
                    req_result = {
                        "epoch": req.get("epoch"),
                        "passed": passed,
                        "reason": reason,
                        "min_version": client_bounds(req, item.client)[0],
                        "max_version": client_bounds(req, item.client)[1],
                        "inherited_from_prev_epoch": req.get("inherited_from_prev_epoch"),
                    }
                    result["requirements"].append(req_result)
                    if not passed:
                        result["ok"] = False
                        result["errors"].append(f"epoch {req.get('epoch')} version {reason}")
            except Exception as exc:  # noqa: BLE001 - report all operational failures.
                result["ok"] = False
                result["errors"].append(str(exc))
            checks.append(result)

    now = datetime.now(timezone.utc)
    return {
        "checked_at_utc": now.isoformat(),
        "checked_at_local": now.astimezone().isoformat(),
        "required_versions": required,
        "participants": participant_results,
        "checks": checks,
    }


def print_required(required: dict[str, list[dict[str, Any]]]) -> None:
    print("SFDP required versions")
    for cluster, rows in required.items():
        print(f"  {cluster}:")
        for row in rows:
            print(
                "    epoch {epoch}: agave {agave_min}..{agave_max} | firedancer {fd_min}..{fd_max}{inherit}".format(
                    epoch=row.get("epoch"),
                    agave_min=row.get("agave_min_version") or "-",
                    agave_max=row.get("agave_max_version") or "none",
                    fd_min=row.get("firedancer_min_version") or "-",
                    fd_max=row.get("firedancer_max_version") or "none",
                    inherit=" inherited" if row.get("inherited_from_prev_epoch") else "",
                )
            )


def print_participants(participants: dict[str, dict[str, Any]]) -> None:
    print("\nSFDP participants")
    for group, result in participants.items():
        item = result.get("participant") or {}
        state = item.get("state", "MISSING")
        onboarding = item.get("sfdp2OnboardingEpoch")
        print(
            f"  {group}: state={state}, onboarding_epoch={onboarding}, "
            f"mainnet={item.get('mainnetBetaPubkey')}, testnet={item.get('testnetPubkey')}"
        )


def print_checks(checks: list[dict[str, Any]]) -> None:
    if not checks:
        print("\nLive validator checks skipped (--api-only).")
        return
    print("\nLive validator checks")
    for check in checks:
        status = "PASS" if check["ok"] else "FAIL"
        print(
            f"  {status} {check['group']} {check['cluster']} {check['host']}:{check['rpc_port']} "
            f"{check.get('version', '?')} identity={check.get('identity', '?')}"
        )
        for req in check.get("requirements", []):
            req_status = "ok" if req["passed"] else f"FAIL {req['reason']}"
            print(
                f"    epoch {req['epoch']}: {req_status} "
                f"(min={req['min_version'] or '-'}, max={req['max_version'] or 'none'})"
            )
        for err in check.get("errors", []):
            print(f"    error: {err}")


def has_failures(data: dict[str, Any], api_only: bool) -> bool:
    for result in data["participants"].values():
        if not result["approved"]:
            return True
    if api_only:
        return False
    return any(not item["ok"] for item in data["checks"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet", default=os.environ.get("VALIDATOR_OPS_FLEET", "~/.config/validator-ops/fleet.json"), help="operator-owned fleet JSON")
    parser.add_argument("--validate-config", action="store_true", help="validate local fleet without network access")
    parser.add_argument("--json", action="store_true", help="print raw JSON output")
    parser.add_argument("--api-only", action="store_true", help="skip SSH/RPC checks and only query SFDP APIs")
    parser.add_argument(
        "--current-only",
        action="store_true",
        help="only check the first required-version row returned for each cluster",
    )
    parser.add_argument("--timeout", type=int, default=12, help="HTTP/SSH timeout in seconds")
    args = parser.parse_args()

    if not 1 <= args.timeout <= 120:
        parser.error("--timeout must be between 1 and 120 seconds")
    try:
        if args.validate_config:
            groups, hosts = load_fleet(args.fleet)
            print(json.dumps({"valid": True, "groups": len(groups), "hosts": len(hosts)}))
            return 0
        data = collect(args)
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(data, indent=2, sort_keys=True))
    else:
        print(f"UTC: {data['checked_at_utc']} | local: {data['checked_at_local']}")
        print_required(data["required_versions"])
        print_participants(data["participants"])
        print_checks(data["checks"])
    return 1 if has_failures(data, args.api_only) else 0


if __name__ == "__main__":
    sys.exit(main())
