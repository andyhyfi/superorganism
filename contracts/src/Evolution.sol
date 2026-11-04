// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title Evolution v0: deposits, splits, withdrawals
/// @notice A network of nodes that grows from one root. Users deposit a token into a live node.
/// Each deposit rolls for a split; the chance rises with the node's fill and is never certain.
/// A split halves the node into two identical children, and every user's claim halves into each.
/// Halves round down to a multiple of `splitUnit` (10 units = 0.00001 USDC, five decimals). The
/// node's split remainder goes to the treasury with the fees.
///
/// Accounting is lazy, so a split never loops over depositors. A user's position is recorded
/// only at nodes the user touched. A claim on any other node is read from the nearest ancestor
/// the user touched, halved once per generation between them.
///
/// No owner, no admin key, no upgrade path. Traits are fixed at deployment; children copy them.
/// v0 has no mutations. Randomness is a placeholder and is NOT safe for real funds.
contract Evolution is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- types

    /// @notice Per-node rules. Fixed in v0; a later mutation build changes these values.
    struct Traits {
        uint32 feePpm; // fee on deposits and withdrawals, parts per million
        uint8 fillMeasure; // what counts as fill; 0 = token amount (the only measure in v0)
        uint128 splitHalfFill; // fill at which the split chance per deposit is 50%
    }

    struct Node {
        uint64 parent; // root points to itself
        uint64 firstChild; // children are firstChild and firstChild + 1; set only after a split
        uint32 depth; // root = 0
        bool split; // true once the node has divided; a split node takes no deposits
        uint128 total; // the node's fill: every claim it holds, plus rounding remainders
        Traits traits;
    }

    struct Position {
        uint128 own; // the user's claim, as of the last time the user touched this node
        bool set; // true once the user has touched this node
    }

    // ------------------------------------------------------------ constants

    uint256 public constant ROOT = 0;
    uint256 public constant PPM = 1_000_000;
    uint32 public constant MAX_FEE_PPM = 10_000; // 1%
    uint8 public constant FILL_TOKEN_AMOUNT = 0;
    uint256 public constant MAX_BATCH = 50; // nodes per withdrawAll call
    uint256 public constant MAX_WALK = 128; // past 128 halvings any uint128 claim is zero

    // ------------------------------------------------------------ immutables

    IERC20 public immutable token;
    address public immutable treasury;
    uint256 public immutable minDeposit;
    uint256 public immutable splitUnit; // halves round down to a multiple of this; 10 = five decimals for USDC

    // ---------------------------------------------------------------- state

    uint256 public nodeCount;
    uint256 public feesAccrued; // owed to the treasury (fees and split remainders), sent by sweepFees()
    uint256 private _nonce;

    mapping(uint256 nodeId => Node) internal _nodes;
    mapping(uint256 nodeId => mapping(address user => Position)) internal _positions;

    // --------------------------------------------------------------- events

    event Deposited(uint256 indexed nodeId, address indexed user, uint256 amount, uint256 fee);
    event Withdrawn(uint256 indexed nodeId, address indexed user, uint256 amount, uint256 fee);
    event Split(uint256 indexed parentId, uint256 child0, uint256 child1, uint32 depth);
    event FeesSwept(address indexed treasury, uint256 amount);

    // --------------------------------------------------------------- errors

    error ZeroAddress();
    error InvalidTraits();
    error UnknownNode(uint256 nodeId);
    error NodeNotLive(uint256 nodeId);
    error BelowMinDeposit(uint256 amount, uint256 minDeposit);
    error ZeroAmount();
    error InsufficientClaim(uint256 requested, uint256 available);
    error BatchTooLarge(uint256 length, uint256 max);
    error NothingToWithdraw();
    error InvalidSplitUnit();

    // Lint notes, reviewed: the split roll's weak randomness is the documented v0 placeholder;
    // the halving in _split rounds down on purpose and sends the remainder to the treasury.

    // ---------------------------------------------------------- constructor

    constructor(IERC20 token_, address treasury_, uint256 minDeposit_, uint256 splitUnit_, Traits memory rootTraits) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (splitUnit_ == 0) revert InvalidSplitUnit();
        _validateTraits(rootTraits);
        token = token_;
        treasury = treasury_;
        minDeposit = minDeposit_ == 0 ? 1 : minDeposit_;
        splitUnit = splitUnit_;

        _nodes[ROOT] = Node({parent: 0, firstChild: 0, depth: 0, split: false, total: 0, traits: rootTraits});
        nodeCount = 1;
    }

    // ------------------------------------------------------------- user API

    /// @notice Deposit `amount` into a live node. The fee goes to the treasury; the rest is the
    /// caller's claim. The deposit then rolls for a split.
    function deposit(uint256 nodeId, uint256 amount) external nonReentrant {
        Node storage node = _live(nodeId);
        if (amount < minDeposit) revert BelowMinDeposit(amount, minDeposit);

        uint256 fee = (amount * node.traits.feePpm) / PPM;
        uint128 credit = (amount - fee).toUint128();

        Position storage pos = _materialize(nodeId, msg.sender);
        pos.own += credit;
        node.total += credit;
        feesAccrued += fee;

        emit Deposited(nodeId, msg.sender, amount, fee);

        if (_rollSplit(nodeId, node.total, node.traits.splitHalfFill)) {
            _split(nodeId, node);
        }

        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw `amount` of the caller's claim from a live node, minus the node's fee.
    function withdraw(uint256 nodeId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        (uint256 payout, uint256 fee) = _take(nodeId, msg.sender, amount);
        feesAccrued += fee;
        token.safeTransfer(msg.sender, payout);
    }

    /// @notice Withdraw the caller's whole claim from each listed node, in one transfer.
    /// Nodes that split since the list was built are skipped; their claims moved to children.
    function withdrawAll(uint256[] calldata nodeIds) external nonReentrant {
        uint256 len = nodeIds.length;
        if (len > MAX_BATCH) revert BatchTooLarge(len, MAX_BATCH);

        uint256 payout = 0;
        uint256 fees = 0;
        for (uint256 i = 0; i < len; ++i) {
            uint256 id = nodeIds[i];
            if (id >= nodeCount || _nodes[id].split) continue;
            uint256 claim = _claim(id, msg.sender);
            if (claim == 0) continue;
            (uint256 p, uint256 f) = _take(id, msg.sender, claim);
            payout += p;
            fees += f;
        }
        if (payout == 0) revert NothingToWithdraw();
        feesAccrued += fees;
        token.safeTransfer(msg.sender, payout);
    }

    /// @notice Send accrued fees to the treasury. Anyone can call.
    function sweepFees() external nonReentrant {
        uint256 amount = feesAccrued;
        if (amount == 0) revert ZeroAmount();
        feesAccrued = 0;
        emit FeesSwept(treasury, amount);
        token.safeTransfer(treasury, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice The amount `user` can withdraw from `nodeId` before fees. Zero for a split node.
    function claimOf(uint256 nodeId, address user) external view returns (uint256) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        if (_nodes[nodeId].split) return 0;
        return _claim(nodeId, user);
    }

    function getNode(uint256 nodeId) external view returns (Node memory) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        return _nodes[nodeId];
    }

    function getPosition(uint256 nodeId, address user) external view returns (Position memory) {
        return _positions[nodeId][user];
    }

    /// @notice Split chance for the next deposit on `nodeId`, scaled to 1e18, given its fill
    /// after that deposit. Pure function of the node's traits; for the UI.
    function splitChance(uint256 nodeId, uint256 fillAfter) external view returns (uint256) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        uint256 half = _nodes[nodeId].traits.splitHalfFill;
        return (fillAfter * 1e18) / (fillAfter + half);
    }

    // ------------------------------------------------------------ internals

    function _live(uint256 nodeId) internal view returns (Node storage node) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        node = _nodes[nodeId];
        if (node.split) revert NodeNotLive(nodeId);
    }

    /// @dev Reads the user's claim on `nodeId` from the nearest node on its path to the root
    /// where the user holds a position, halved once per generation of distance with the same
    /// rounding as node totals. A position includes everything inherited above it, so one
    /// ancestor is enough.
    function _claim(uint256 nodeId, address user) internal view returns (uint256) {
        uint256 n = nodeId;
        for (uint256 d = 0; d <= MAX_WALK; ++d) {
            Position storage pos = _positions[n][user];
            if (pos.set) {
                uint256 c = pos.own;
                for (uint256 i = 0; i < d && c != 0; ++i) {
                    c = _half(c);
                }
                return c;
            }
            if (n == ROOT) return 0;
            n = _nodes[n].parent;
        }
        return 0;
    }

    /// @dev Half of `x`, rounded down to a multiple of `splitUnit`. The halves of a node's
    /// claims sum to at most the half of its total, so rounding never creates value.
    function _half(uint256 x) internal view returns (uint256) {
        uint256 h = x / 2;
        return h - (h % splitUnit);
    }

    /// @dev Records the user's inherited claim at `nodeId` so later reads stop here.
    function _materialize(uint256 nodeId, address user) internal returns (Position storage pos) {
        pos = _positions[nodeId][user];
        if (!pos.set) {
            pos.own = _claim(nodeId, user).toUint128();
            pos.set = true;
        }
    }

    /// @dev Removes `amount` from the user's claim and the node's fill. Returns the payout and
    /// the fee; the caller adds the fee to `feesAccrued` once, outside any loop.
    function _take(uint256 nodeId, address user, uint256 amount) internal returns (uint256 payout, uint256 fee) {
        Node storage node = _live(nodeId);
        Position storage pos = _materialize(nodeId, user);
        if (amount > pos.own) revert InsufficientClaim(amount, pos.own);

        uint128 a = amount.toUint128();
        pos.own -= a;
        node.total -= a; // node.total >= every claim in it, so this cannot underflow

        fee = (amount * node.traits.feePpm) / PPM;
        payout = amount - fee;

        emit Withdrawn(nodeId, user, amount, fee);
    }

    /// @dev Divides a node into two identical children.
    ///
    /// Remainder rules, in order:
    /// 1. Each child's total is `_half(parent.total)`: half the parent, rounded down to a
    ///    multiple of `splitUnit` (10 base units = 0.00001 USDC).
    /// 2. The node-level remainder, `parent.total - 2 * childTotal`, goes to the treasury: it is
    ///    added to `feesAccrued` and leaves with the next `sweepFees()`. It is at most
    ///    `2 * splitUnit - 1` base units per split.
    /// 3. Each user's claim on a child is `_half` of their parent claim, rounded the same way, read
    ///    lazily by `_claim`. Because `floor((a + b) / k) >= floor(a / k) + floor(b / k)`, the halves
    ///    of a node's claims never sum to more than the half of its total. A child's total is
    ///    therefore always at least the sum of its claims, and rounding never creates value.
    /// 4. The gap between a child's total and the sum of its claims is unowned fill: per-user
    ///    rounding that belongs to nobody. It stays in the node, counts toward the node's fill,
    ///    halves with the node at every later split, and its share of each split remainder goes
    ///    to the treasury under rule 2. Paying it out at split time would require a loop over
    ///    depositors, which the contract never does.
    ///
    /// The parent keeps its recorded total for history but takes no further deposits or
    /// withdrawals; its claims now live in the children.
    function _split(uint256 nodeId, Node storage node) internal {
        uint256 c0 = nodeCount;
        nodeCount = c0 + 2;

        uint128 half = _half(node.total).toUint128();
        feesAccrued += uint256(node.total) - 2 * uint256(half);

        uint32 depth = node.depth + 1;
        uint64 parent = nodeId.toUint64();
        node.split = true;
        node.firstChild = c0.toUint64();

        Node memory child =
            Node({parent: parent, firstChild: 0, depth: depth, split: false, total: half, traits: node.traits});
        _nodes[c0] = child;
        _nodes[c0 + 1] = child;

        emit Split(nodeId, c0, c0 + 1, depth);
    }

    /// @dev Split roll. Succeeds with probability fill / (fill + halfFill), so never certain.
    /// PLACEHOLDER randomness from block data: predictable and gameable by a contract caller
    /// that reverts on an unwanted result. Replace before real funds.
    function _rollSplit(uint256 nodeId, uint256 fill, uint256 halfFill) internal virtual returns (bool) {
        uint256 r = uint256(keccak256(abi.encode(block.prevrandao, block.number, nodeId, msg.sender, _nonce++)));
        return r % (fill + halfFill) < fill;
    }

    function _validateTraits(Traits memory t) internal pure {
        if (t.feePpm > MAX_FEE_PPM || t.splitHalfFill == 0 || t.fillMeasure != FILL_TOKEN_AMOUNT) {
            revert InvalidTraits();
        }
    }
}
