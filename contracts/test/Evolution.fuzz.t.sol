// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../src/Evolution.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EvolutionHarness} from "./utils/EvolutionHarness.sol";

/// @notice Property tests over random amounts, fees and rounding units.
contract EvolutionFuzzTest is Test {
    MockUSDC internal usdc;
    address internal constant TREASURY = address(0xFEE);
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
    }

    function _deploy(uint32 feePpm, uint256 splitUnit) internal returns (EvolutionHarness e) {
        e = new EvolutionHarness(
            IERC20(address(usdc)), TREASURY, 1, 1, splitUnit, 20, Evolution.Traits(feePpm, 0, 100_000, 300e6)
        );
        e.setMode(EvolutionHarness.Mode.Never);
        address[2] memory u = [alice, bob];
        for (uint256 i = 0; i < 2; ++i) {
            usdc.mint(u[i], type(uint128).max);
            vm.prank(u[i]);
            usdc.approve(address(e), type(uint256).max);
        }
    }

    /// _half never exceeds half and always lands on a multiple of the unit.
    function testFuzz_half(uint256 x, uint256 unit) public {
        x = bound(x, 0, type(uint128).max);
        unit = bound(unit, 1, 1e6);
        EvolutionHarness e = _deploy(0, unit);
        uint256 h = e.exposedHalf(x);
        assertLe(2 * h, x);
        assertEq(h % unit, 0);
        assertLt(x - 2 * h, 2 * unit);
    }

    /// Rounding each part never yields more than rounding the whole.
    function testFuzz_halfIsSubadditive(uint256 a, uint256 b, uint256 unit) public {
        a = bound(a, 0, type(uint120).max);
        b = bound(b, 0, type(uint120).max);
        unit = bound(unit, 1, 1e6);
        EvolutionHarness e = _deploy(0, unit);
        assertLe(e.exposedHalf(a) + e.exposedHalf(b), e.exposedHalf(a + b));
    }

    /// Two depositors, one split, both withdraw everything from both children: nobody gets more
    /// than they put in, and the contract keeps only treasury-bound value and unowned fill.
    function testFuzz_splitThenDrain(uint256 a, uint256 b, uint32 feePpm, uint256 unit) public {
        a = bound(a, 1, 1e15);
        b = bound(b, 1, 1e15);
        feePpm = uint32(bound(feePpm, 0, 10_000));
        unit = bound(unit, 1, 1e4);
        EvolutionHarness e = _deploy(feePpm, unit);

        vm.prank(alice);
        e.deposit(0, a);
        e.setMode(EvolutionHarness.Mode.Always);
        vm.prank(bob);
        e.deposit(0, b);
        e.setMode(EvolutionHarness.Mode.Never);

        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (1, 2);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(alice);
        try e.withdrawAll(ids) {} catch {}
        vm.prank(bob);
        try e.withdrawAll(ids) {} catch {}

        assertLe(usdc.balanceOf(alice) - aBefore, a);
        assertLe(usdc.balanceOf(bob) - bBefore, b);
        if (e.feesAccrued() > 0) e.sweepFees();
        uint256 unowned = e.getNode(1).total + e.getNode(2).total;
        assertEq(usdc.balanceOf(address(e)), unowned);
        assertLe(unowned, 4 * unit); // two users, two children, under one unit each
    }

    /// Partial withdrawals in any order never let a user exceed their claim.
    function testFuzz_partialWithdrawals(uint256 amount, uint256 w1, uint256 w2) public {
        amount = bound(amount, 2, 1e15);
        EvolutionHarness e = _deploy(1, 10);
        vm.prank(alice);
        e.deposit(0, amount);
        uint256 claim = e.claimOf(0, alice);
        w1 = bound(w1, 1, claim);
        vm.prank(alice);
        e.withdraw(0, w1);
        uint256 rest = e.claimOf(0, alice);
        assertEq(rest, claim - w1);
        if (rest == 0) return;
        w2 = bound(w2, rest + 1, type(uint128).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Evolution.InsufficientClaim.selector, w2, rest));
        e.withdraw(0, w2);
    }

    /// Claims read through many generations equal repeated halving, with no stored position.
    function testFuzz_lazyClaimMatchesRepeatedHalving(uint256 amount, uint8 generations) public {
        amount = bound(amount, 1, 1e15);
        generations = uint8(bound(generations, 1, 40));
        EvolutionHarness e = _deploy(0, 10);
        vm.prank(alice);
        e.deposit(0, amount);
        uint256 node = 0;
        e.setMode(EvolutionHarness.Mode.Always);
        for (uint256 i = 0; i < generations; ++i) {
            vm.prank(bob);
            e.deposit(node, 1);
            node = e.getNode(node).firstChild;
        }
        uint256 expect = amount;
        for (uint256 i = 0; i < generations; ++i) {
            expect = e.exposedHalf(expect);
        }
        assertEq(e.claimOf(node, alice), expect);
        assertEq(e.getPosition(node, alice).set, false); // read lazily, never written
    }

    /// The roll chance never decreases with fill and never reaches the cap.
    function testFuzz_rollChanceMonotonicAndCapped(uint256 a, uint256 b) public {
        a = bound(a, 0, type(uint128).max);
        b = bound(b, a, type(uint128).max);
        EvolutionHarness e = _deploy(0, 10);
        uint256 ca = e.rollChance(0, a);
        uint256 cb = e.rollChance(0, b);
        assertLe(ca, cb);
        assertLe(cb, 0.1e18);
    }
}
