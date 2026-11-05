// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../src/Evolution.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EvolutionHarness} from "./utils/EvolutionHarness.sol";

/// @notice Energy loans, loan events, deposit limits. The core rule under test: loans never
/// change what any user can withdraw, and a withdrawal never fails because of a loan.
contract EvolutionLoansTest is Test {
    MockUSDC internal usdc;
    EvolutionHarness internal evo;

    address internal constant TREASURY = address(0xFEE);
    address internal op;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

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

    function _openEvent() internal returns (uint256 id) {
        evo.setEventMode(EvolutionHarness.Mode.Always);
        _deposit(bob, 1, 1e6);
        evo.setEventMode(EvolutionHarness.Mode.Never);
        id = evo.pendingRequest();
    }

    /// Runs events with fresh randomness until node `lender` lends to node `borrower`.
    function _forceLoan(uint256 lender, uint256 borrower) internal returns (uint256 loanId) {
        for (uint256 seed = 0; seed < 500; ++seed) {
            uint256 id = _openEvent();
            vm.prank(op);
            evo.runLoanEvent(id, seed);
            Evolution.LoanView[] memory out = evo.loansOut(lender);
            Evolution.LoanView[] memory back = evo.loansOut(borrower);
            if (out.length > 0 && out[0].holder == borrower && back.length == 0) return out[0].loanId;
            vm.warp(block.timestamp + 2 hours); // let any other loans expire and try again
        }
        revert("no loan made");
    }

    // ------------------------------------------------------------ limits

    function test_limits_perDepositAndPerUser() public {
        Evolution.Config memory c = Evolution.Config({
            token: IERC20(address(usdc)),
            treasury: TREASURY,
            operator: op,
            minDeposit: 1,
            minWithdraw: 1,
            maxDeposit: 1_000e6,
            maxPerUser: 1_000e6,
            eventFee: 0,
            splitUnit: 10,
            splitOdds: 20
        });
        Evolution e = new Evolution(c, Evolution.Traits(0, 0, 1, 1e30), Evolution.LoanRules(0, 300, 3600, 1));
        vm.startPrank(alice);
        usdc.approve(address(e), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(Evolution.AboveMaxDeposit.selector, 1_000e6 + 1, 1_000e6));
        e.deposit(0, 1_000e6 + 1);
        e.deposit(0, 600e6);
        vm.expectRevert(abi.encodeWithSelector(Evolution.AboveUserLimit.selector, 1_100e6, 1_000e6));
        e.deposit(0, 500e6);
        e.withdraw(0, 200e6); // room again after a withdrawal
        e.deposit(0, 600e6);
        assertEq(e.heldOf(alice), 1_000e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ events

    function test_event_depositOpensRequestAndPaysFee() public {
        Evolution.Config memory c = Evolution.Config({
            token: IERC20(address(usdc)),
            treasury: TREASURY,
            operator: op,
            minDeposit: 1,
            minWithdraw: 1,
            maxDeposit: 1_000e6,
            maxPerUser: 1_000e6,
            eventFee: 10_000,
            splitUnit: 10,
            splitOdds: 20
        });
        // event chance 50% (the cap); try deposits until one opens a request
        Evolution e = new Evolution(c, Evolution.Traits(0, 0, 1, 1e30), Evolution.LoanRules(500_000, 300, 3600, 1));
        vm.startPrank(alice);
        usdc.approve(address(e), type(uint256).max);
        uint256 before = usdc.balanceOf(alice);
        uint256 n = 0;
        while (e.pendingRequest() == 0 && n < 64) {
            vm.roll(block.number + 1);
            vm.prevrandao(bytes32(n));
            e.deposit(0, 1e6);
            ++n;
        }
        vm.stopPrank();
        assertEq(e.pendingRequest(), 1);
        assertEq(before - usdc.balanceOf(alice), n * 1e6 + 10_000, "only the opening deposit pays the fee");
        assertEq(e.feesAccrued(), 10_000);
        assertEq(e.claimOf(0, alice), n * 1e6, "the fee is not taken from the claim");
    }

    function test_event_onlyOperatorAndOnlyOpenRequest() public {
        _twoNodes();
        uint256 id = _openEvent();
        vm.expectRevert(Evolution.NotOperator.selector);
        evo.runLoanEvent(id, 1);
        vm.prank(op);
        evo.runLoanEvent(id + 1, 1); // not the open request: ignored
        assertEq(evo.pendingRequest(), id);
        vm.prank(op);
        evo.runLoanEvent(id, 1);
        assertEq(evo.pendingRequest(), 0);
        uint256 loans = evo.loanCount();
        vm.prank(op);
        evo.runLoanEvent(id, 2); // answered already: ignored
        assertEq(evo.loanCount(), loans);
    }

    function test_event_requestTimesOut() public {
        _twoNodes();
        uint256 id = _openEvent();
        evo.setEventMode(EvolutionHarness.Mode.Always);
        _deposit(bob, 1, 1e6);
        assertEq(evo.pendingRequest(), id, "an open request blocks a second one");
        vm.warp(block.timestamp + evo.REQUEST_TIMEOUT());
        _deposit(bob, 1, 1e6);
        assertEq(evo.pendingRequest(), id + 1, "an expired request is replaced");
    }

    function test_event_neverRevertsWithOneLiveNode() public {
        _deposit(alice, 0, 10e6);
        evo.setEventMode(EvolutionHarness.Mode.Always);
        _deposit(alice, 0, 1e6);
        uint256 id = evo.pendingRequest();
        vm.prank(op);
        evo.runLoanEvent(id, 12345);
        assertEq(evo.loanCount(), 0, "a node never lends to itself");
    }

    // ------------------------------------------------------------ loans

    function test_loan_isEnergyOnlyAndCountsAtMostHalf() public {
        _twoNodes();
        uint256 loanId = _forceLoan(1, 2);
        Evolution.Loan memory l = evo.getLoan(loanId);
        (uint256 own1, uint256 lent1,,) = evo.energyOf(1);
        (uint256 own2,, uint256 borrowed2, uint256 fill2) = evo.energyOf(2);
        assertEq(lent1, l.amount);
        assertEq(borrowed2, l.amount);
        assertGe(l.amount, (own1 * 5) / 100);
        assertLe(l.amount, (own1 * 20) / 100);
        assertEq(fill2, own2 + l.amount);
        assertEq(evo.exposedRollFill(1), own1 - l.amount);
        assertEq(evo.claimOf(1, alice), 100e6, "lending changes no claim");
        assertEq(evo.claimOf(2, alice), 100e6, "borrowing changes no claim");
        assertGe(l.due, block.timestamp + 5 minutes);
        assertLe(l.due, block.timestamp + 60 minutes);
    }

    function test_loan_borrowedCountsAtMostOwn() public {
        _twoNodes();
        _forceLoan(1, 2);
        // empty node 2 to 0.01: borrowed energy now counts only up to 0.01
        vm.prank(alice);
        evo.withdraw(2, 100e6 - 10_000);
        (uint256 own2,, uint256 borrowed2, uint256 fill2) = evo.energyOf(2);
        assertGt(borrowed2, own2);
        assertEq(fill2, 2 * own2);
    }

    function test_loan_endsAtDueTime() public {
        _twoNodes();
        uint256 loanId = _forceLoan(1, 2);
        vm.warp(evo.getLoan(loanId).due);
        (, uint256 lent,,) = evo.energyOf(1);
        (,, uint256 borrowed,) = evo.energyOf(2);
        assertEq(lent, 0);
        assertEq(borrowed, 0);
        assertEq(evo.loansOut(1).length, 0);
        assertEq(evo.loansIn(2).length, 0);
    }

    function test_withdraw_repaysEveryLoanOutAndPaysExactly() public {
        _twoNodes();
        uint256 loanId = _forceLoan(1, 2);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        evo.withdraw(1, 1e6);
        assertEq(usdc.balanceOf(alice) - before, 1e6, "a loan never changes the payout");
        assertTrue(evo.getLoan(loanId).ended);
        (,, uint256 borrowed,) = evo.energyOf(2);
        assertEq(borrowed, 0, "the borrower lost the energy at once");
    }

    function test_withdraw_fromBorrowerLeavesLoanAndPaysExactly() public {
        _twoNodes();
        uint256 loanId = _forceLoan(1, 2);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        evo.withdraw(2, 100e6); // the whole own claim; borrowed energy is not withdrawable
        assertEq(usdc.balanceOf(alice) - before, 100e6);
        assertFalse(evo.getLoan(loanId).ended);
        vm.prank(alice);
        vm.expectRevert(Evolution.NothingToWithdraw.selector);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 2;
        evo.withdrawAll(ids);
    }

    function test_split_borrowerHalvesPartsLenderEndsLoans() public {
        _twoNodes();
        uint256 loanId = _forceLoan(1, 2);
        uint128 amount = evo.getLoan(loanId).amount;

        evo.setMode(EvolutionHarness.Mode.Always);
        _deposit(bob, 2, 1e6); // borrower splits into 3 and 4
        evo.setMode(EvolutionHarness.Mode.Never);
        (,, uint256 b3,) = evo.energyOf(3);
        (,, uint256 b4,) = evo.energyOf(4);
        assertEq(b3 + b4, amount, "parts still sum to the loan");
        assertGe(b3, b4);
        assertLe(b3 - b4, 1);

        evo.setMode(EvolutionHarness.Mode.Always);
        _deposit(bob, 1, 1e6); // lender splits: its loan ends everywhere
        evo.setMode(EvolutionHarness.Mode.Never);
        assertTrue(evo.getLoan(loanId).ended);
        (,, b3,) = evo.energyOf(3);
        (,, b4,) = evo.energyOf(4);
        assertEq(b3 + b4, 0);
    }

    function test_liveNodesTracksSplits() public {
        _twoNodes();
        uint256[] memory live = evo.liveNodes();
        assertEq(live.length, 2);
        assertEq(live[0] + live[1], 3);
    }

    /// Differential: the same deposits and withdrawals pay exactly the same with loan events
    /// running in between as without them.
    function testFuzz_loansNeverChangePayouts(uint256 seed, uint96 a, uint96 b) public {
        uint256 amtA = bound(a, 2e6, 400e6);
        uint256 amtB = bound(b, 2e6, 400e6);
        EvolutionHarness quiet = new EvolutionHarness(
            IERC20(address(usdc)), TREASURY, 1, 1, 10, 20, Evolution.Traits(100, 0, 100_000, 300e6)
        );
        EvolutionHarness busy = new EvolutionHarness(
            IERC20(address(usdc)), TREASURY, 1, 1, 10, 20, Evolution.Traits(100, 0, 100_000, 300e6)
        );
        uint256[2] memory paid;
        EvolutionHarness[2] memory es = [quiet, busy];
        for (uint256 k = 0; k < 2; ++k) {
            EvolutionHarness e = es[k];
            vm.prank(alice);
            usdc.approve(address(e), type(uint256).max);
            vm.prank(bob);
            usdc.approve(address(e), type(uint256).max);
            e.setMode(EvolutionHarness.Mode.Always);
            vm.prank(alice);
            e.deposit(0, amtA);
            e.setMode(EvolutionHarness.Mode.Never);
            vm.prank(bob);
            e.deposit(1, amtB);
            if (k == 1) {
                for (uint256 i = 0; i < 4; ++i) {
                    e.setEventMode(EvolutionHarness.Mode.Always);
                    vm.prank(bob);
                    e.deposit(2, 1e6);
                    e.setEventMode(EvolutionHarness.Mode.Never);
                    uint256 req = e.pendingRequest();
                    vm.prank(op);
                    e.runLoanEvent(req, uint256(keccak256(abi.encode(seed, i))));
                }
            } else {
                for (uint256 i = 0; i < 4; ++i) {
                    vm.prank(bob);
                    e.deposit(2, 1e6);
                }
            }
            uint256 before = usdc.balanceOf(alice) + usdc.balanceOf(bob);
            uint256[] memory ids = new uint256[](3);
            (ids[0], ids[1], ids[2]) = (0, 1, 2);
            vm.prank(alice);
            e.withdrawAll(ids);
            vm.prank(bob);
            e.withdrawAll(ids);
            paid[k] = usdc.balanceOf(alice) + usdc.balanceOf(bob) - before;
        }
        assertEq(paid[0], paid[1]);
    }
}
