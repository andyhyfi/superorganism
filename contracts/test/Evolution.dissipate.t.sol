// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../src/Evolution.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EvolutionHarness} from "./utils/EvolutionHarness.sol";

/// @notice Dissipation: an empty, quiet node leaves the network. The core rule under test: no
/// claim is ever lost, and a node with deposits or loans can never be removed.
contract EvolutionDissipateTest is Test {
    MockUSDC internal usdc;
    EvolutionHarness internal evo;

    address internal constant TREASURY = address(0xFEE);
    address internal op;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal anyone = makeAddr("anyone");

    function setUp() public {
        usdc = new MockUSDC();
        evo =
            new EvolutionHarness(IERC20(address(usdc)), TREASURY, 1, 1, 10, 20, Evolution.Traits(0, 0, 100_000, 300e6));
        op = evo.OPERATOR();
        evo.setMode(EvolutionHarness.Mode.Never);
        address[2] memory u = [alice, bob];
        for (uint256 i = 0; i < 2; ++i) {
            usdc.mint(u[i], 1_000_000e6);
            vm.prank(u[i]);
            usdc.approve(address(evo), type(uint256).max);
        }
    }

    function _deposit(address u, uint256 nodeId, uint256 amount) internal {
        vm.prank(u);
        evo.deposit(nodeId, amount);
    }

    /// Root splits into nodes 1 and 2; alice holds 100 in each.
    function _twoNodes() internal {
        evo.setMode(EvolutionHarness.Mode.Always);
        _deposit(alice, 0, 200e6);
        evo.setMode(EvolutionHarness.Mode.Never);
    }

    /// Node 1 emptied by alice at time t.
    function _emptyNode1() internal {
        _twoNodes();
        uint256 c = evo.claimOf(1, alice);
        vm.prank(alice);
        evo.withdraw(1, c);
    }

    function test_dissipate_afterQuietTime() public {
        _emptyNode1();
        assertFalse(evo.canDissipate(1));
        vm.warp(block.timestamp + 5 minutes);
        assertTrue(evo.canDissipate(1));
        vm.prank(anyone);
        evo.dissipate(1);
        assertTrue(evo.getNode(1).gone);
        uint256[] memory live = evo.liveNodes();
        assertEq(live.length, 1);
        assertEq(live[0], 2);
    }

    function test_dissipate_revertsBeforeQuietTime() public {
        _emptyNode1();
        vm.warp(block.timestamp + 5 minutes - 1);
        vm.expectRevert();
        evo.dissipate(1);
    }

    function test_dissipate_revertsWithDeposits() public {
        _twoNodes();
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(Evolution.NotEmpty.selector, 1, evo.getNode(1).total));
        evo.dissipate(1);
    }

    function test_dissipate_revertsOnSplitAndUnknown() public {
        _twoNodes();
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(Evolution.NodeNotLive.selector, 0));
        evo.dissipate(0);
        vm.expectRevert(abi.encodeWithSelector(Evolution.UnknownNode.selector, 99));
        evo.dissipate(99);
    }

    function test_dissipate_neverTheLastNode() public {
        vm.warp(block.timestamp + 1 hours);
        assertFalse(evo.canDissipate(0));
        vm.expectRevert(Evolution.LastNode.selector);
        evo.dissipate(0);
    }

    function test_dissipate_onlyOnce_andGoneTakesNoDeposits() public {
        _emptyNode1();
        vm.warp(block.timestamp + 5 minutes);
        evo.dissipate(1);
        vm.expectRevert(abi.encodeWithSelector(Evolution.NodeGone.selector, 1));
        evo.dissipate(1);
        vm.expectRevert(abi.encodeWithSelector(Evolution.NodeGone.selector, 1));
        _deposit(bob, 1, 5e6);
    }

    function test_dissipate_activeLoanKeepsNodeUntilQuietAfterDue() public {
        // node 1 empty but borrowing from node 2: it stays until the loan's due time + quiet time
        _twoNodes();
        uint256 c = evo.claimOf(1, alice);
        vm.prank(alice);
        evo.withdraw(1, c);
        uint256 due;
        for (uint256 seed = 0; seed < 500; ++seed) {
            evo.setEventMode(EvolutionHarness.Mode.Always);
            _deposit(bob, 2, 1e6);
            evo.setEventMode(EvolutionHarness.Mode.Never);
            uint256 id = evo.pendingRequest();
            vm.prank(op);
            evo.runLoanEvent(id, seed);
            Evolution.LoanView[] memory inn = evo.loansIn(1);
            if (inn.length > 0) {
                due = inn[0].due;
                break;
            }
        }
        require(due != 0, "no loan into node 1");
        assertGe(evo.getNode(1).busyUntil, due);
        vm.warp(due - 1);
        vm.expectRevert(abi.encodeWithSelector(Evolution.HasLoans.selector, 1));
        evo.dissipate(1);
        vm.warp(due + 5 minutes - 1);
        assertFalse(evo.canDissipate(1));
        vm.warp(due + 5 minutes);
        assertTrue(evo.canDissipate(1));
        evo.dissipate(1);
    }

    /// The safety rule: a rounding leftover in a gone node is still withdrawable by its owner.
    function test_dissipate_leftoverClaimStaysWithdrawable() public {
        // alice and bob share the root; it splits, leaving per-user rounding in the children
        _deposit(bob, 0, 3_333_337);
        evo.setMode(EvolutionHarness.Mode.Always);
        _deposit(alice, 0, 7_777_771);
        evo.setMode(EvolutionHarness.Mode.Never);
        // alice withdraws all from node 1; bob takes all but a few base units (below DUST)
        uint256 c = evo.claimOf(1, alice);
        vm.prank(alice);
        evo.withdraw(1, c);
        uint256 bobClaim = evo.claimOf(1, bob);
        uint256 keep = 7;
        vm.prank(bob);
        evo.withdraw(1, bobClaim - keep);
        assertLt(evo.getNode(1).total, evo.DUST());
        vm.warp(block.timestamp + 5 minutes);
        evo.dissipate(1);
        assertEq(evo.claimOf(1, bob), keep);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        evo.withdraw(1, keep);
        assertEq(usdc.balanceOf(bob) - before, keep); // fee is 0 in this setup
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(alice);
        vm.expectRevert(Evolution.NothingToWithdraw.selector);
        evo.withdrawAll(ids);
    }

    function test_dissipate_loanEventsSkipGoneNodes() public {
        _emptyNode1();
        vm.warp(block.timestamp + 5 minutes);
        evo.dissipate(1);
        for (uint256 seed = 0; seed < 50; ++seed) {
            evo.setEventMode(EvolutionHarness.Mode.Always);
            _deposit(bob, 2, 1e6);
            evo.setEventMode(EvolutionHarness.Mode.Never);
            uint256 id = evo.pendingRequest();
            vm.prank(op);
            evo.runLoanEvent(id, seed);
        }
        assertEq(evo.loansIn(1).length, 0);
        assertEq(evo.loansOut(1).length, 0);
    }

    function test_activity_resetsQuietClock() public {
        _emptyNode1();
        vm.warp(block.timestamp + 4 minutes);
        _deposit(bob, 1, 1e6);
        uint256 cb = evo.claimOf(1, bob);
        vm.prank(bob);
        evo.withdraw(1, cb);
        vm.warp(block.timestamp + 4 minutes);
        assertFalse(evo.canDissipate(1));
        vm.warp(block.timestamp + 1 minutes);
        assertTrue(evo.canDissipate(1));
    }
}
