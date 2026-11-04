// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../src/Evolution.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EvolutionHarness} from "./utils/EvolutionHarness.sol";

contract EvolutionUnitTest is Test {
    MockUSDC internal usdc;
    EvolutionHarness internal evo;

    address internal constant TREASURY = address(0xFEE);
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint32 internal constant FEE_PPM = 1; // 0.0001%
    uint256 internal constant SPLIT_UNIT = 10; // five decimals for USDC
    uint32 internal constant CAP_PPM = 100_000; // 10%
    uint128 internal constant MID_FILL = 300e6;
    uint256 internal constant ODDS = 20;

    function setUp() public {
        usdc = new MockUSDC();
        evo = new EvolutionHarness(IERC20(address(usdc)), TREASURY, 1, 1, SPLIT_UNIT, ODDS, _traits());
        evo.setMode(EvolutionHarness.Mode.Never);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; ++i) {
            usdc.mint(users[i], 1_000_000e6);
            vm.prank(users[i]);
            usdc.approve(address(evo), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ helpers

    function _traits() internal pure returns (Evolution.Traits memory) {
        return Evolution.Traits(FEE_PPM, 0, CAP_PPM, MID_FILL);
    }

    function _deposit(address u, uint256 nodeId, uint256 amount) internal {
        vm.prank(u);
        evo.deposit(nodeId, amount);
    }

    function _depositSplitting(address u, uint256 nodeId, uint256 amount) internal {
        evo.setMode(EvolutionHarness.Mode.Always);
        _deposit(u, nodeId, amount);
        evo.setMode(EvolutionHarness.Mode.Never);
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_PPM) / 1_000_000;
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
    }

    // ------------------------------------------------------- construction

    function test_constructor_setsRoot() public view {
        Evolution.Node memory root = evo.getNode(0);
        assertEq(evo.nodeCount(), 1);
        assertEq(root.depth, 0);
        assertFalse(root.split);
        assertEq(root.total, 0);
        assertEq(root.traits.feePpm, FEE_PPM);
        assertEq(evo.splitUnit(), SPLIT_UNIT);
        assertEq(evo.treasury(), TREASURY);
    }

    function test_constructor_rejectsBadInputs() public {
        Evolution.Traits memory ok = _traits();
        IERC20 t = IERC20(address(usdc));
        vm.expectRevert(Evolution.ZeroAddress.selector);
        new Evolution(IERC20(address(0)), TREASURY, 1, 1, SPLIT_UNIT, ODDS, ok);
        vm.expectRevert(Evolution.ZeroAddress.selector);
        new Evolution(t, address(0), 1, 1, SPLIT_UNIT, ODDS, ok);
        vm.expectRevert(Evolution.InvalidSplitUnit.selector);
        new Evolution(t, TREASURY, 1, 1, 0, ODDS, ok);
        vm.expectRevert(Evolution.InvalidSplitOdds.selector);
        new Evolution(t, TREASURY, 1, 1, SPLIT_UNIT, 0, ok);
        vm.expectRevert(Evolution.InvalidTraits.selector);
        new Evolution(t, TREASURY, 1, 1, SPLIT_UNIT, ODDS, Evolution.Traits(10_001, 0, CAP_PPM, MID_FILL));
        vm.expectRevert(Evolution.InvalidTraits.selector);
        new Evolution(t, TREASURY, 1, 1, SPLIT_UNIT, ODDS, Evolution.Traits(FEE_PPM, 1, CAP_PPM, MID_FILL));
        vm.expectRevert(Evolution.InvalidTraits.selector);
        new Evolution(t, TREASURY, 1, 1, SPLIT_UNIT, ODDS, Evolution.Traits(FEE_PPM, 0, 100_001, MID_FILL));
        vm.expectRevert(Evolution.InvalidTraits.selector);
        new Evolution(t, TREASURY, 1, 1, SPLIT_UNIT, ODDS, Evolution.Traits(FEE_PPM, 0, CAP_PPM, 0));
    }

    // ------------------------------------------------------------ deposit

    function test_deposit_creditsClaimAndFee() public {
        _deposit(alice, 0, 100e6);
        uint256 fee = _fee(100e6);
        assertEq(fee, 100); // 0.0001 USDC
        assertEq(evo.claimOf(0, alice), 100e6 - fee);
        assertEq(evo.getNode(0).total, 100e6 - fee);
        assertEq(evo.feesAccrued(), fee);
        assertEq(usdc.balanceOf(address(evo)), 100e6);
    }

    function test_deposit_revertsBelowMinimumAndOnUnknownOrSplitNode() public {
        EvolutionHarness strict =
            new EvolutionHarness(IERC20(address(usdc)), TREASURY, 1e6, 1e6, SPLIT_UNIT, ODDS, _traits());
        strict.setMode(EvolutionHarness.Mode.Never);
        vm.startPrank(alice);
        usdc.approve(address(strict), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(Evolution.BelowMinDeposit.selector, 1e6 - 1, 1e6));
        strict.deposit(0, 1e6 - 1);
        vm.expectRevert(abi.encodeWithSelector(Evolution.UnknownNode.selector, 7));
        strict.deposit(7, 1e6);
        vm.stopPrank();

        _depositSplitting(alice, 0, 10e6);
        vm.expectRevert(abi.encodeWithSelector(Evolution.NodeNotLive.selector, 0));
        _deposit(bob, 0, 10e6);
    }

    // -------------------------------------------------------------- split

    function test_split_halvesNodeAndEveryClaim() public {
        _deposit(alice, 0, 100e6);
        _depositSplitting(bob, 0, 60e6);

        assertEq(evo.nodeCount(), 3);
        assertTrue(evo.getNode(0).split);
        assertEq(evo.getNode(0).firstChild, 1);

        uint256 aliceParent = 100e6 - _fee(100e6);
        uint256 bobParent = 60e6 - _fee(60e6);
        for (uint256 child = 1; child <= 2; ++child) {
            Evolution.Node memory n = evo.getNode(child);
            assertEq(n.parent, 0);
            assertEq(n.depth, 1);
            assertEq(n.total, evo.exposedHalf(aliceParent + bobParent));
            assertEq(evo.claimOf(child, alice), evo.exposedHalf(aliceParent));
            assertEq(evo.claimOf(child, bob), evo.exposedHalf(bobParent));
        }
        assertEq(evo.claimOf(0, alice), 0); // a split node holds no claims
    }

    function test_split_childrenCopyTraits() public {
        _depositSplitting(alice, 0, 10e6);
        Evolution.Traits memory t = evo.getNode(1).traits;
        assertEq(t.feePpm, FEE_PPM);
        assertEq(t.rollCapPpm, CAP_PPM);
        assertEq(t.rollMidFill, MID_FILL);
        assertEq(abi.encode(evo.getNode(1).traits), abi.encode(evo.getNode(2).traits));
    }

    function test_split_remainderGoesToTreasury() public {
        // 100.123457 USDC deposit: credit 100.123357, half 50.0616785 -> rounds to 50.06167
        _depositSplitting(alice, 0, 100_123_457);
        uint256 credit = 100_123_457 - _fee(100_123_457);
        uint256 half = evo.exposedHalf(credit);
        assertEq(half % SPLIT_UNIT, 0);
        assertEq(evo.feesAccrued(), _fee(100_123_457) + (credit - 2 * half));
        assertLt(credit - 2 * half, 2 * SPLIT_UNIT);
    }

    function test_split_deepLineageReadsLazily() public {
        _deposit(alice, 0, 1_024e6);
        // Split the left-most lineage ten times; alice never touches any child.
        uint256 node = 0;
        for (uint256 i = 0; i < 10; ++i) {
            _depositSplitting(bob, node, 1e6);
            node = evo.getNode(node).firstChild;
        }
        assertEq(evo.getNode(node).depth, 10);
        uint256 expect = 1_024e6 - _fee(1_024e6);
        for (uint256 i = 0; i < 10; ++i) {
            expect = evo.exposedHalf(expect);
        }
        assertEq(evo.claimOf(node, alice), expect);
        assertApproxEqAbs(expect, 1e6, 100); // about 1 USDC after ten halvings
    }

    function test_split_depositOnChildDoesNotTouchSibling() public {
        _deposit(alice, 0, 100e6);
        _depositSplitting(bob, 0, 1e6);
        uint256 siblingBefore = evo.getNode(2).total;
        _deposit(carol, 1, 40e6);
        assertEq(evo.getNode(2).total, siblingBefore);
        assertEq(evo.claimOf(2, carol), 0);
        assertEq(evo.claimOf(1, carol), 40e6 - _fee(40e6));
    }

    // ----------------------------------------------------------- withdraw

    function test_withdraw_paysClaimMinusFee() public {
        _deposit(alice, 0, 100e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        evo.withdraw(0, 40e6);
        assertEq(usdc.balanceOf(alice) - before, 40e6 - _fee(40e6));
        assertEq(evo.claimOf(0, alice), 100e6 - _fee(100e6) - 40e6);
    }

    function test_withdraw_cannotExceedOwnClaim() public {
        _deposit(alice, 0, 100e6);
        _deposit(bob, 0, 500e6);
        uint256 claim = evo.claimOf(0, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Evolution.InsufficientClaim.selector, claim + 1, claim));
        evo.withdraw(0, claim + 1);
    }

    function test_withdraw_othersDepositsNeverRaiseLimit() public {
        _deposit(alice, 0, 100e6);
        _depositSplitting(bob, 0, 1e6);
        uint256 aliceChild = evo.claimOf(1, alice);
        _deposit(carol, 1, 900e6);
        assertEq(evo.claimOf(1, alice), aliceChild);
    }

    function test_withdraw_revertsOnZeroAndSplitNode() public {
        _deposit(alice, 0, 100e6);
        vm.prank(alice);
        vm.expectRevert(Evolution.ZeroAmount.selector);
        evo.withdraw(0, 0);
        _depositSplitting(bob, 0, 1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Evolution.NodeNotLive.selector, 0));
        evo.withdraw(0, 1);
    }

    function test_withdrawAll_sweepsEveryLiveClaim() public {
        _deposit(alice, 0, 100e6);
        _depositSplitting(bob, 0, 1e6);
        uint256 expected = 0;
        for (uint256 c = 1; c <= 2; ++c) {
            uint256 cl = evo.claimOf(c, alice);
            expected += cl - _fee(cl);
        }
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        evo.withdrawAll(_ids(0, 1, 2)); // node 0 is split and skipped
        assertEq(usdc.balanceOf(alice) - before, expected);
        assertEq(evo.claimOf(1, alice), 0);
        assertEq(evo.claimOf(2, alice), 0);
    }

    function test_withdrawAll_capsBatchAndRejectsEmpty() public {
        uint256[] memory big = new uint256[](51);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Evolution.BatchTooLarge.selector, 51, 50));
        evo.withdrawAll(big);
        vm.prank(alice);
        vm.expectRevert(Evolution.NothingToWithdraw.selector);
        evo.withdrawAll(_ids(0, 0, 0));
    }

    function test_withdrawAll_duplicateIdsCannotDoubleSpend() public {
        _deposit(alice, 0, 100e6);
        uint256 claim = evo.claimOf(0, alice);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        evo.withdrawAll(_ids(0, 0, 0));
        assertEq(usdc.balanceOf(alice) - before, claim - _fee(claim));
    }

    function test_withdrawAll_skipsUnknownIds() public {
        _deposit(alice, 0, 100e6);
        vm.prank(alice);
        evo.withdrawAll(_ids(0, 999, type(uint256).max));
        assertEq(evo.claimOf(0, alice), 0);
    }

    // --------------------------------------------------------------- fees

    function test_sweepFees_paysTreasuryOnly() public {
        _deposit(alice, 0, 100e6);
        uint256 owed = evo.feesAccrued();
        vm.prank(carol); // anyone can trigger
        evo.sweepFees();
        assertEq(usdc.balanceOf(TREASURY), owed);
        assertEq(evo.feesAccrued(), 0);
        vm.expectRevert(Evolution.ZeroAmount.selector);
        evo.sweepFees();
    }

    // --------------------------------------------------------- full drain

    function test_fullDrain_leavesOnlyUnownedFill() public {
        _deposit(alice, 0, 100_123_457);
        _deposit(bob, 0, 33_333_333);
        _depositSplitting(carol, 0, 7_777_777);
        _depositSplitting(alice, 1, 1_234_567);

        address[3] memory users = [alice, bob, carol];
        uint256[] memory ids = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            ids[i] = i;
        }
        for (uint256 i = 0; i < 3; ++i) {
            vm.prank(users[i]);
            try evo.withdrawAll(ids) {} catch {}
        }
        evo.sweepFees();

        uint256 unowned = 0;
        for (uint256 i = 0; i < evo.nodeCount(); ++i) {
            if (!evo.getNode(i).split) unowned += evo.getNode(i).total;
        }
        assertEq(usdc.balanceOf(address(evo)), unowned);
        assertLt(unowned, 100); // a handful of base units at most
    }

    // ------------------------------------------------- minimum withdrawal

    function test_withdraw_minimumUnlessClosingClaim() public {
        EvolutionHarness strict =
            new EvolutionHarness(IERC20(address(usdc)), TREASURY, 1e6, 1e6, SPLIT_UNIT, ODDS, _traits());
        strict.setMode(EvolutionHarness.Mode.Never);
        vm.startPrank(alice);
        usdc.approve(address(strict), type(uint256).max);
        strict.deposit(0, 5e6);
        vm.expectRevert(abi.encodeWithSelector(Evolution.BelowMinWithdraw.selector, 1e6 - 1, 1e6));
        strict.withdraw(0, 1e6 - 1);
        strict.withdraw(0, 1e6);
        vm.stopPrank();

        // After a split, a claim under the minimum can still close out in full.
        strict.setMode(EvolutionHarness.Mode.Always);
        vm.prank(bob);
        usdc.approve(address(strict), type(uint256).max);
        vm.prank(bob);
        strict.deposit(0, 1e6);
        strict.setMode(EvolutionHarness.Mode.Never);
        uint256 small = strict.claimOf(1, alice);
        assertGt(small, 0);
        vm.startPrank(alice);
        strict.withdraw(1, strict.claimOf(1, alice)); // whole claim: allowed
        vm.stopPrank();
        assertEq(strict.claimOf(1, alice), 0);
    }

    // ------------------------------------------------------- split chance

    function test_rollChance_matchesTargets() public view {
        // 1 USDC: about 0.0001%. 100 USDC: 1%. 300 USDC: 5%. 1,000 USDC: about 9.17%.
        assertApproxEqRel(evo.rollChance(0, 1e6), 1.111e12, 0.001e18);
        assertApproxEqAbs(evo.rollChance(0, 100e6), 0.01e18, 1);
        assertApproxEqAbs(evo.rollChance(0, 300e6), 0.05e18, 1);
        assertApproxEqRel(evo.rollChance(0, 1_000e6), 0.0917431e18, 0.0001e18);
        assertEq(evo.rollChance(0, 0), 0);
    }

    function test_rollChance_risesFlatThenSteepThenFlatAndStaysUnderCap() public view {
        uint256 prev = 0;
        uint256 prevStep = 0;
        bool steepening = true;
        for (uint256 usd = 50; usd <= 5_000; usd += 50) {
            uint256 c = evo.rollChance(0, usd * 1e6);
            assertGt(c, prev);
            assertLt(c, 0.1e18);
            uint256 step = c - prev;
            if (prev != 0 && step < prevStep) steepening = false; // past the steepest point
            if (!steepening) assertLe(step, prevStep); // once it flattens, it keeps flattening
            prev = c;
            prevStep = step;
        }
        assertLt(evo.rollChance(0, type(uint128).max), 0.1e18 + 1);
    }

    function test_splitChance_isRollChanceOverOdds() public view {
        assertEq(evo.splitChance(0, 100e6), evo.rollChance(0, 100e6) / ODDS);
        assertApproxEqAbs(evo.splitChance(0, 100e6), 0.0005e18, 1); // 1% x 1/20 = 0.05%
    }

    function test_realRoll_layersMultiplyStatistically() public {
        // Cap 10% at a huge fill, odds 1-in-2: a split should land about 5% of the time.
        EvolutionHarness e = new EvolutionHarness(
            IERC20(address(usdc)), TREASURY, 1, 1, SPLIT_UNIT, 2, Evolution.Traits(0, 0, CAP_PPM, 1)
        );
        uint256 trials = 4_000;
        uint256 hits = 0;
        for (uint256 i = 0; i < trials; ++i) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(i)))));
            if (e.exposedRoll(1e30)) ++hits;
        }
        // Expected 200; one standard deviation is about 14. Allow 5.
        assertApproxEqAbs(hits, 200, 70);
    }

    function test_realRoll_smallNodeAlmostNeverSplits() public {
        EvolutionHarness e = new EvolutionHarness(IERC20(address(usdc)), TREASURY, 1, 1, SPLIT_UNIT, ODDS, _traits());
        uint256 hits = 0;
        for (uint256 i = 0; i < 2_000; ++i) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(i)))));
            if (e.exposedRoll(1e6)) ++hits; // 1 USDC: one split in about 18 million
        }
        assertEq(hits, 0);
    }
}
