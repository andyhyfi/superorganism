// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../../src/Evolution.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {EvolutionHarness} from "../utils/EvolutionHarness.sol";
import {Handler} from "./Handler.sol";

/// @notice Properties that must hold after every random sequence of actions.
contract EvolutionInvariantTest is Test {
    MockUSDC internal usdc;
    EvolutionHarness internal evo;
    Handler internal handler;
    address[] internal actors;

    address internal constant TREASURY = address(0xFEE);
    uint256 internal constant SPLIT_UNIT = 10;

    function setUp() public {
        usdc = new MockUSDC();
        // A high fee (1%) makes fee rounding visible. Forced splits drive the tree; the real roll
        // runs too, with the production curve and odds.
        evo = new EvolutionHarness(
            IERC20(address(usdc)), TREASURY, 1, 1, SPLIT_UNIT, 20, Evolution.Traits(10_000, 0, 100_000, 300e6)
        );
        for (uint256 i = 0; i < 5; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("actor", vm.toString(i)))));
        }
        handler = new Handler(evo, usdc, actors);
        targetContract(address(handler));
    }

    // ------------------------------------------------------------ helpers

    function _liveTotals() internal view returns (uint256 sum) {
        for (uint256 i = 0; i < evo.nodeCount(); ++i) {
            Evolution.Node memory n = evo.getNode(i);
            if (!n.split) sum += n.total;
        }
    }

    function _claimsOf(address u) internal view returns (uint256 sum) {
        for (uint256 i = 0; i < evo.nodeCount(); ++i) {
            sum += evo.claimOf(i, u); // zero for split nodes
        }
    }

    // --------------------------------------------------------- invariants

    /// The contract's token balance is exactly fees owed plus every live node's total.
    function invariant_balanceEqualsFeesPlusLiveTotals() public view {
        assertEq(usdc.balanceOf(address(evo)), evo.feesAccrued() + _liveTotals());
    }

    /// No node owes more than it holds: the sum of claims on a node is at most its total.
    function invariant_nodeClaimsNeverExceedTotal() public view {
        for (uint256 i = 0; i < evo.nodeCount(); ++i) {
            Evolution.Node memory n = evo.getNode(i);
            if (n.split) continue;
            uint256 claims = 0;
            for (uint256 a = 0; a < actors.length; ++a) {
                claims += evo.claimOf(i, actors[a]);
            }
            assertLe(claims, n.total);
        }
    }

    /// Solvency: the contract holds everything it owes to users and to the treasury.
    function invariant_solvent() public view {
        uint256 owed = evo.feesAccrued();
        for (uint256 a = 0; a < actors.length; ++a) {
            owed += _claimsOf(actors[a]);
        }
        assertGe(usdc.balanceOf(address(evo)), owed);
    }

    /// No user ever gets out more than they put in. Splits and rounding never create value.
    function invariant_noUserGainsValue() public view {
        for (uint256 a = 0; a < actors.length; ++a) {
            address u = actors[a];
            assertLe(handler.received(u) + _claimsOf(u), handler.deposited(u));
        }
    }

    /// Loans: energy lent out of live nodes equals energy borrowed by live nodes, exactly.
    function invariant_loansBalance() public view {
        uint256[] memory live = evo.liveNodes();
        uint256 lent = 0;
        uint256 borrowed = 0;
        for (uint256 i = 0; i < live.length; ++i) {
            (, uint256 l, uint256 b,) = evo.energyOf(live[i]);
            lent += l;
            borrowed += b;
        }
        assertEq(lent, borrowed);
    }

    /// Every live node is in the live list exactly once.
    function invariant_liveListMatchesTree() public view {
        uint256 count = 0;
        for (uint256 i = 0; i < evo.nodeCount(); ++i) {
            if (!evo.getNode(i).split) ++count;
        }
        assertEq(evo.liveNodes().length, count);
    }

    /// Structure: children point at their parent, sit one level deeper, and copy its traits.
    function invariant_treeIsConsistent() public view {
        uint256 n = evo.nodeCount();
        assertEq(n % 2, 1); // root plus pairs
        for (uint256 i = 0; i < n; ++i) {
            Evolution.Node memory node = evo.getNode(i);
            if (!node.split) continue;
            for (uint256 c = node.firstChild; c <= node.firstChild + 1; ++c) {
                Evolution.Node memory child = evo.getNode(c);
                assertEq(child.parent, i);
                assertEq(child.depth, node.depth + 1);
                assertEq(abi.encode(child.traits), abi.encode(node.traits));
            }
        }
    }

    /// After each run, every user withdraws everything and the treasury is paid. What remains is
    /// exactly the unowned fill in live nodes, and it is small.
    function afterInvariant() public {
        uint256 n = evo.nodeCount();
        for (uint256 a = 0; a < actors.length; ++a) {
            for (uint256 start = 0; start < n; start += 50) {
                uint256 len = n - start < 50 ? n - start : 50;
                uint256[] memory ids = new uint256[](len);
                for (uint256 k = 0; k < len; ++k) {
                    ids[k] = start + k;
                }
                vm.prank(actors[a]);
                try evo.withdrawAll(ids) {} catch {}
            }
            assertEq(_claimsOf(actors[a]), 0, "claim left after full withdrawal");
        }
        if (evo.feesAccrued() > 0) evo.sweepFees();
        emit log_named_uint("loan events", handler.events());
        emit log_named_uint("loans made", handler.loans());
        emit log_named_uint("nodes", n);

        uint256 left = usdc.balanceOf(address(evo));
        assertEq(left, _liveTotals(), "balance differs from unowned fill");
        // Per live node, unowned fill is bounded by per-user rounding: at most one split unit per
        // actor per generation of halving, so actors * splitUnit * depth bounds it loosely.
        uint256 bound_ = 0;
        for (uint256 i = 0; i < n; ++i) {
            Evolution.Node memory node = evo.getNode(i);
            if (!node.split) bound_ += actors.length * SPLIT_UNIT * (uint256(node.depth) + 1);
        }
        assertLe(left, bound_, "unowned fill above rounding bound");
    }
}
