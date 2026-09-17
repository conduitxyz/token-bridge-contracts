#!/usr/bin/env bash
# Verifies a deployed L1AtomicTokenBridgeCreator matches a local build: proxy,
# implementation, and the L2 factory template whose runtime code is shipped to the
# child chain (so this is what actually names the wrapped native token).
#
# Usage:
#   ./scripts/verifyTokenBridgeCreatorBytecode.sh <ref|local> <rpc-url> <proxy-address>
#
# Examples:
#   ./scripts/verifyTokenBridgeCreatorBytecode.sh local \
#     https://rpc.hyperliquid-testnet.xyz/evm 0x7cC6F0C5D5B729E706c772E403619509FaE5fA78
#   ./scripts/verifyTokenBridgeCreatorBytecode.sh v1.2.3 \
#     https://rpc.hyperliquid-testnet.xyz/evm 0x4B9f70dA0e40Cf22C6Dbd8763073934D980214C9
#
# Build with hardhat (yarn build), not forge - forge output differs in compiler
# metadata handling and shows spurious mismatches.
#
# Only proves code identity. Says nothing about who deployed it, constructor args,
# ownership, or whether the deploy key is compromised.
set -euo pipefail

REF="${1:?usage: $0 <ref|local> <rpc-url> <proxy-address>}"
RPC="${2:?usage: $0 <ref|local> <rpc-url> <proxy-address>}"
PROXY="${3:?usage: $0 <ref|local> <rpc-url> <proxy-address>}"

EIP1967_IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$REF" = "local" ]; then
  BUILD_DIR="$REPO_ROOT"
  echo "==> Using working tree at $BUILD_DIR"
else
  BUILD_DIR="$(mktemp -d)"
  trap 'rm -rf "$BUILD_DIR"' EXIT
  echo "==> Cloning $REF into $BUILD_DIR"
  git clone --quiet --branch "$REF" "$(git -C "$REPO_ROOT" remote get-url origin)" "$BUILD_DIR"
fi

echo "==> yarn install && yarn build (hardhat)"
(cd "$BUILD_DIR" && yarn install --silent && yarn build >/dev/null)

IMPL="0x$(cast storage "$PROXY" "$EIP1967_IMPL_SLOT" -r "$RPC" | tail -c 41)"
FACTORY="$(cast call "$PROXY" 'l2TokenBridgeFactoryTemplate()(address)' -r "$RPC")"
echo "    implementation:   $IMPL"
echo "    factory template: $FACTORY"

artifact_code() {
  python3 -c "import json;a=json.load(open('$1'));b=a['deployedBytecode'];print((b['object'] if isinstance(b,dict) else b).lower())"
}

rc=0
compare() {
  local label="$1" artifact="$2" address="$3"
  local want have
  want="$(artifact_code "$BUILD_DIR/$artifact")"
  have="$(cast code "$address" -r "$RPC" | tr '[:upper:]' '[:lower:]')"
  if [ "$want" = "$have" ]; then
    echo "[$label] MATCH ($address, $(( (${#want} - 2) / 2 )) bytes)"
  else
    echo "[$label] MISMATCH ($address) - local $(( (${#want}-2)/2 ))B vs onchain $(( (${#have}-2)/2 ))B" >&2
    rc=1
  fi
}

compare "proxy"           "build/contracts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json" "$PROXY"
compare "implementation"  "build/contracts/contracts/tokenbridge/ethereum/L1AtomicTokenBridgeCreator.sol/L1AtomicTokenBridgeCreator.json"              "$IMPL"
compare "factoryTemplate" "build/contracts/contracts/tokenbridge/arbitrum/L2AtomicTokenBridgeFactory.sol/L2AtomicTokenBridgeFactory.json"              "$FACTORY"

# Wrapped-native name actually baked into the template. Solc stores short string
# literals bit-shifted to shrink the PUSH operand, so "WETH" is not byte-aligned
# and won't show up as ASCII - absence of WETH is not evidence of anything.
echo "==> Wrapped native name in factory template:"
cast code "$FACTORY" -r "$RPC" | python3 -c "
import sys
b=bytes.fromhex(sys.stdin.read().strip().removeprefix('0x'))
for s in (b'WHYPE', b'WETH'):
    print(f'    {s.decode():6} x{b.count(s)}')"

exit $rc
