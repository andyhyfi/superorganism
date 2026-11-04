// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../src/Evolution.sol";
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

    uint256 internal constant ACCOUNTS = 10;
    uint256 internal constant FUND = 100_000e6;

    // Anvil's default test mnemonic. Public, local only, never holds value.
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";

    function run() external {
        require(block.chainid == 31337, "local chain only");

        uint256 deployerKey = vm.deriveKey(MNEMONIC, 0);
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        MockUSDC usdc = new MockUSDC();
        Evolution evo = new Evolution(
            IERC20(address(usdc)),
            deployer, // treasury: the deployer, local only
            MIN_DEPOSIT,
            MIN_WITHDRAW,
            SPLIT_UNIT,
            SPLIT_ODDS,
            Evolution.Traits(FEE_PPM, 0, ROLL_CAP_PPM, ROLL_MID_FILL)
        );
        for (uint256 i = 0; i < ACCOUNTS; ++i) {
            usdc.mint(vm.addr(vm.deriveKey(MNEMONIC, uint32(i))), FUND);
        }
        vm.stopBroadcast();

        // Seed the root with deposits from accounts 1 to 3 so the field is not empty.
        uint256[3] memory seeds = [uint256(40e6), 25e6, 60e6];
        for (uint256 i = 0; i < seeds.length; ++i) {
            uint256 key = vm.deriveKey(MNEMONIC, uint32(i + 1));
            vm.startBroadcast(key);
            usdc.approve(address(evo), type(uint256).max);
            evo.deposit(0, seeds[i]);
            vm.stopBroadcast();
        }

        string memory obj = "local";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "usdc", address(usdc));
        vm.serializeAddress(obj, "treasury", deployer);
        string memory json = vm.serializeAddress(obj, "evolution", address(evo));
        vm.writeJson(json, "deployments/local.json");

        console.log("MockUSDC ", address(usdc));
        console.log("Evolution", address(evo));
        console.log("Nodes    ", evo.nodeCount());
    }
}
