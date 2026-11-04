#!/usr/bin/env bash
# Starts a local test chain on this Mac and deploys the contracts to it.
#
#   ./local.sh         start the chain, deploy, and keep running (Ctrl+C stops it)
#
# Local only: chain ID 31337 at http://127.0.0.1:8545. Every restart starts from zero.
# The test accounts use anvil's public test mnemonic and hold only mock USDC.
set -euo pipefail

export PATH="$PATH:$HOME/.foundry/bin"
cd "$(dirname "$0")/contracts"

RPC=http://127.0.0.1:8545

if curl -s -o /dev/null -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC"; then
  echo "Something is already running on port 8545. Stop it first." >&2
  exit 1
fi

anvil --chain-id 31337 --block-time 1 --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null' EXIT

for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done

mkdir -p deployments
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url "$RPC" --broadcast --slow -q

echo
echo "Local chain running at $RPC (chain ID 31337, 1-second blocks)."
echo "Addresses: contracts/deployments/local.json"
cat deployments/local.json
echo
echo "Ctrl+C to stop."
wait $ANVIL
