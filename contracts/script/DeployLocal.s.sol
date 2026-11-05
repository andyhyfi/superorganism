// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../src/Evolution.sol";
import {EvolutionDemo} from "../src/mocks/EvolutionDemo.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Local chain only (anvil, chain ID 31337). Deploys mock USDC and Evolution with the
/// current default rules, gives each test account 100,000 mock USDC, seeds the root node with a
/// few deposits, and writes the addresses to deployments/local.json for the app.
contract DeployLocal is Script {
    // Default rules, matching contracts/README.md.
    uint256 internal constant MIN_DEPOSIT = 1e6; // 1 USDC
    uint256 internal constant MIN_WITHDRAW = 1e6; // 1 USDC
    uint256 internal constant SPLIT_UNIT = 10; // five decimals
    uint256 internal constant SPLIT_ODDS = 20; // layer two: 1 in 20
    uint32 internal constant FEE_PPM = 1; // 0.0001%
    uint32 internal constant ROLL_CAP_PPM = 100_000; // 10%
    uint128 internal constant ROLL_MID_FILL = 300e6; // 300 USDC

    // Loan rules (Andy, 2026-11-05): a deposit starts a loan event 15% of the time, loans last
    // 5 to 60 minutes, one loan out per node. Limits: 1,000 USDC per deposit and per user.
    uint32 internal constant EVENT_CHANCE_PPM = 150_000;
    uint32 internal constant LOAN_MIN_SECS = 5 minutes;
    uint32 internal constant LOAN_MAX_SECS = 60 minutes;
    uint8 internal constant LOANS_OUT_CAP = 1;
    uint256 internal constant MAX_DEPOSIT = 1_000e6;
    uint256 internal constant MAX_PER_USER = 1_000e6;
    // The depositor pays the random-number fee. Gelato's price is not known yet; 0.01 USDC is a
    // local placeholder.
    uint256 internal constant EVENT_FEE = 10_000;
    // Account 11 of the test mnemonic plays the randomness operator on the local chain
    // (scripts/activity.mjs answers each request). On Ink this is the Gelato VRF operator.
    uint32 internal constant OPERATOR_INDEX = 11;

    uint256 internal constant ACCOUNTS = 10;
    uint256 internal constant FUND = 100_000e6;

    // Demo preset (default): same curve shape and 10% cap, but a 60 USDC midpoint and 1-in-2
    // split odds, so splits happen every few minutes under gentle test activity. PRESET=real uses
    // the production rules above. Local chain only; never the deployed rules.
    uint128 internal constant DEMO_MID_FILL = 60e6;
    uint256 internal constant DEMO_SPLIT_ODDS = 2;

    // Split-test preset (PRESET=splits, temporary, for testing the split mechanic): the roll curve
    // reaches its 10% cap almost at once (2 USDC midpoint) and every won roll splits (1 in 1), so
    // about 1 deposit in 10 splits a cell. 10% is the contract's hard cap.
    uint128 internal constant SPLITS_MID_FILL = 2e6;
    uint256 internal constant SPLITS_SPLIT_ODDS = 1;

    // Anvil's default test mnemonic. Public, local only, never holds value.
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";

    function run() external {
        require(block.chainid == 31337, "local chain only");

        uint256 deployerKey = vm.deriveKey(MNEMONIC, 0);
        address deployer = vm.addr(deployerKey);
        string memory preset = vm.envOr("PRESET", string("demo"));
        bool demo = keccak256(bytes(preset)) != keccak256("real");
        bool splits = keccak256(bytes(preset)) == keccak256("splits");

        vm.startBroadcast(deployerKey);
        MockUSDC usdc = new MockUSDC();
        address operator = vm.addr(vm.deriveKey(MNEMONIC, OPERATOR_INDEX));
        EvolutionDemo evo = new EvolutionDemo(
            Evolution.Config({
                token: IERC20(address(usdc)),
                treasury: deployer, // local only; Andy's treasury fund on testnet and mainnet
                operator: operator,
                minDeposit: MIN_DEPOSIT,
                minWithdraw: MIN_WITHDRAW,
                maxDeposit: MAX_DEPOSIT,
                maxPerUser: MAX_PER_USER,
                eventFee: EVENT_FEE,
                splitUnit: SPLIT_UNIT,
                splitOdds: splits ? SPLITS_SPLIT_ODDS : demo ? DEMO_SPLIT_ODDS : SPLIT_ODDS
            }),
            Evolution.Traits(FEE_PPM, 0, ROLL_CAP_PPM, splits ? SPLITS_MID_FILL : demo ? DEMO_MID_FILL : ROLL_MID_FILL),
            Evolution.LoanRules(EVENT_CHANCE_PPM, LOAN_MIN_SECS, LOAN_MAX_SECS, LOANS_OUT_CAP)
        );
        for (uint256 i = 0; i < ACCOUNTS; ++i) {
            usdc.mint(vm.addr(vm.deriveKey(MNEMONIC, uint32(i))), FUND);
        }
        vm.stopBroadcast();

        // Seed the network: 5 live cells (Andy's starting mode), each with a few deposits. The test dials force a split
        // on each seeding deposit (and turn events off), then go back to the real rules.
        vm.startBroadcast(deployerKey);
        evo.setDemoDials(1_000_000, 1);
        vm.stopBroadcast();
        uint256[4] memory grow = [uint256(240e6), 90e6, 70e6, 60e6];
        for (uint256 i = 0; i < grow.length; ++i) {
            uint256 key = vm.deriveKey(MNEMONIC, uint32(1 + (i % 3)));
            uint256[] memory live = evo.liveNodes();
            vm.startBroadcast(key);
            if (i < 3) usdc.approve(address(evo), type(uint256).max);
            evo.deposit(live[i % live.length], grow[i]);
            vm.stopBroadcast();
        }
        vm.startBroadcast(deployerKey);
        evo.setDemoDials(0, 0);
        vm.stopBroadcast();

        string memory obj = "local";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "preset", splits ? "splits" : demo ? "demo" : "real");
        vm.serializeAddress(obj, "usdc", address(usdc));
        vm.serializeAddress(obj, "treasury", deployer);
        vm.serializeAddress(obj, "operator", operator);
        string memory json = vm.serializeAddress(obj, "evolution", address(evo));
        vm.writeJson(json, "deployments/local.json");

        console.log("MockUSDC ", address(usdc));
        console.log("Evolution", address(evo));
        console.log("Nodes    ", evo.nodeCount());
    }
}
