#!/usr/bin/env bash
# Confirms a deployed L1AtomicTokenBridgeCreator (proxy + implementation) is byte-for-byte
# identical to an unmodified build of this repo at a given tag/ref - i.e. not tampered with
# or substituted for different bytecode.
#
# Usage:
#   ./scripts/verifyTokenBridgeCreatorBytecode.sh <ref> <rpc-url> <proxy-address>
#
# Example (HyperEVM testnet, token-bridge-contracts@v1.2.3):
#   ./scripts/verifyTokenBridgeCreatorBytecode.sh v1.2.3 \
#     https://rpc.hyperliquid-testnet.xyz/evm \
#     0x4B9f70dA0e40Cf22C6Dbd8763073934D980214C9
#
# Notes:
# - Builds with `yarn build` (hardhat), the same toolchain the deploy scripts in this repo
#   use. Comparing against a `forge build` output will show spurious diffs (different
#   compiler-metadata/pipeline handling between hardhat and foundry, not a real mismatch) -
#   don't use forge for this check, even though this repo also has a foundry.toml.
# - Only checks bytecode identity. It does not (and cannot) confirm who deployed it, what
#   constructor args/ownership were used, or that the deployer's private key is uncompromised
#   - it only proves the code running at these addresses matches this repo's source exactly.
set -euo pipefail

REF="${1:?usage: $0 <ref> <rpc-url> <proxy-address>}"
RPC="${2:?usage: $0 <ref> <rpc-url> <proxy-address>}"
PROXY="${3:?usage: $0 <ref> <rpc-url> <proxy-address>}"

EIP1967_IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Reading implementation address from proxy $PROXY (EIP-1967 slot)"
IMPL_PADDED="$(cast storage "$PROXY" "$EIP1967_IMPL_SLOT" -r "$RPC")"
IMPL="0x${IMPL_PADDED: -40}"
echo "    implementation: $IMPL"

echo "==> Cloning this repo at $REF into $WORKDIR"
git clone --quiet --branch "$REF" "$(git remote get-url origin)" "$WORKDIR"
cd "$WORKDIR"

echo "==> yarn install && yarn build (hardhat - matches the actual deploy scripts)"
yarn install --silent
yarn build >/dev/null

PROXY_ARTIFACT="build/contracts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json"
IMPL_ARTIFACT="build/contracts/contracts/tokenbridge/ethereum/L1AtomicTokenBridgeCreator.sol/L1AtomicTokenBridgeCreator.json"

compare() {
  local label="$1" artifact="$2" address="$3"
  local local_bytecode onchain_bytecode
  local_bytecode="$(python3 -c "import json;a=json.load(open('$artifact'));b=a['deployedBytecode'];print(b['object'] if isinstance(b, dict) else b)" | tr '[:upper:]' '[:lower:]')"
  onchain_bytecode="$(cast code "$address" -r "$RPC" | tr '[:upper:]' '[:lower:]')"
  if [ "$local_bytecode" = "$onchain_bytecode" ]; then
    echo "[$label] MATCH ($address, $(( (${#local_bytecode} - 2) / 2 )) bytes)"
  else
    echo "[$label] MISMATCH ($address) - deployed bytecode does NOT match $REF" >&2
    exit 1
  fi
}

compare "proxy"          "$PROXY_ARTIFACT" "$PROXY"
compare "implementation" "$IMPL_ARTIFACT"  "$IMPL"

echo "==> Both proxy and implementation match $REF exactly."
