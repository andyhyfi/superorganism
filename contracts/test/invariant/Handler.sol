// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Evolution} from "../../src/Evolution.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {EvolutionHarness} from "../utils/EvolutionHarness.sol";

/// @notice Drives random sequences of deposits, splits, withdrawals, batch withdrawals and fee
/// sweeps, and keeps ghost totals the invariants compare against.
contract Handler is Test {
    EvolutionHarness public evo;
    MockUSDC public usdc;
    address[] public actors;

    mapping(address => uint256) public deposited; // gross amounts sent in
    mapping(address => uint256) public received; // net amounts paid out
    uint256 public splits;
    uint256 public calls;

    constructor(EvolutionHarness evo_, MockUSDC usdc_, address[] memory actors_) {
        evo = evo_;
        usdc = usdc_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ------------------------------------------------------------ actions

    function deposit(uint256 actorSeed, uint256 nodeSeed, uint256 amount, uint256 modeSeed) external {
        address u = actors[actorSeed % actors.length];
        uint256 nodeId = _liveNode(nodeSeed);
        amount = bound(amount, 1, 1_000_000e6);

        uint256 m = modeSeed % 4;
        evo.setMode(
            m == 0 ? EvolutionHarness.Mode.Always : m == 1 ? EvolutionHarness.Mode.Real : EvolutionHarness.Mode.Never
        );

        uint256 before = evo.nodeCount();
        usdc.mint(u, amount);
        vm.startPrank(u);
        usdc.approve(address(evo), amount);
        evo.deposit(nodeId, amount);
        vm.stopPrank();

        deposited[u] += amount;
        if (evo.nodeCount() > before) ++splits;
        ++calls;
    }

    function withdraw(uint256 actorSeed, uint256 nodeSeed, uint256 amount) external {
        address u = actors[actorSeed % actors.length];
        uint256 nodeId = _liveNode(nodeSeed);
        uint256 claim = evo.claimOf(nodeId, u);
        if (claim == 0) return;
        amount = bound(amount, 1, claim);

        uint256 before = usdc.balanceOf(u);
        vm.prank(u);
        evo.withdraw(nodeId, amount);
        received[u] += usdc.balanceOf(u) - before;
        ++calls;
    }

    function withdrawAll(uint256 actorSeed) external {
        address u = actors[actorSeed % actors.length];
        uint256 n = evo.nodeCount();
        uint256[] memory ids = new uint256[](n < 50 ? n : 50);
        uint256 k = 0;
        for (uint256 i = n; i > 0 && k < ids.length; --i) {
            ids[k++] = i - 1; // newest first: live nodes cluster at the end
        }
        uint256 before = usdc.balanceOf(u);
        vm.prank(u);
        try evo.withdrawAll(ids) {
            received[u] += usdc.balanceOf(u) - before;
        } catch {}
        ++calls;
    }

    function sweepFees() external {
        if (evo.feesAccrued() == 0) return;
        evo.sweepFees();
        ++calls;
    }

    // ------------------------------------------------------------ helpers

    function _liveNode(uint256 seed) internal view returns (uint256) {
        uint256 n = evo.nodeCount();
        uint256 start = seed % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = (start + i) % n;
            if (!evo.getNode(id).split) return id;
        }
        revert("no live node"); // unreachable: every split adds two live nodes
    }
}
