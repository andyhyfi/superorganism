// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Evolution v2: deposits, splits, energy loans, withdrawals
/// @notice A network of nodes that grows from one root. Users deposit a token into a live node.
///
/// Money: a user's claim is a fixed token amount. Only the user's own deposits and withdrawals
/// change it, and a split halves it into the two children. Nothing else changes a claim.
///
/// Splits: every deposit can split its node, in two layers:
/// 1. The roll chance comes from the node's roll fill on an S-curve with a hard cap of at most
///    10%. With the default traits: 0.0001% at 1 USDC, 1% at 100 USDC, about 9.2% at 1,000 USDC.
/// 2. A deposit that wins the roll chance then rolls a fixed 1-in-`splitOdds` for the split.
/// A split halves the node into two identical children, and every user's claim halves into each.
/// Halves round down to a multiple of `splitUnit`. The node's split remainder goes to the treasury.
///
/// Energy loans: a deposit can start a loan event (chance set per node). A random number from the
/// randomness operator runs the event: up to 5 sends, each from a random live node (the lender)
/// to a different random live node (the borrower). A loan is energy only. It moves no tokens and
/// changes no claim. It ends at its due time, when the lender splits, or when any user withdraws
/// from the lender (a withdrawal repays every loan out of the node it touches). Borrowed energy
/// counts toward the borrower's roll fill, at most as much as the borrower's own energy (so loans
/// are at most 50% of the fill), and each send rolls the borrower for a split.
///
/// Accounting is lazy, so a split never loops over depositors. A user's position is recorded
/// only at nodes the user touched. A claim on any other node is read from the nearest ancestor
/// the user touched, halved once per generation between them.
///
/// No owner, no admin key, no upgrade path. Rules are fixed at deployment; children copy them.
/// The split and event rolls inside a deposit use block data: a placeholder that is NOT safe for
/// real funds. The loan event itself uses the operator's random number (Gelato VRF on Ink).
contract Evolution is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- types

    /// @notice Per-node split and fee rules. Children copy them.
    struct Traits {
        uint32 feePpm; // fee on deposits and withdrawals, parts per million
        uint8 fillMeasure; // what counts as fill; 0 = token amount (the only measure)
        uint32 rollCapPpm; // ceiling of the roll-chance curve, parts per million; at most 10%
        uint128 rollMidFill; // fill at which the roll chance is half the cap
    }

    /// @notice Per-node loan rules. Children copy them. Each has a hard cap in code.
    struct LoanRules {
        uint32 eventChancePpm; // chance that a deposit into this node starts a loan event; at most 50%
        uint32 loanMinSecs; // shortest loan this node gives; at least 60 s
        uint32 loanMaxSecs; // longest loan this node gives; at most 1 day
        uint8 loansOutCap; // most loans this node can have out at once; at most 4
    }

    struct Node {
        uint64 parent; // root points to itself
        uint64 firstChild; // children are firstChild and firstChild + 1; set only after a split
        uint32 depth; // root = 0
        bool split; // true once the node has divided; a split node takes no deposits
        uint128 total; // the node's own energy: every claim it holds, plus rounding remainders
        Traits traits;
        LoanRules loanRules;
    }

    struct Position {
        uint128 own; // the user's claim, as of the last time the user touched this node
        bool set; // true once the user has touched this node
    }

    /// @notice Deployment settings, fixed for the life of the contract.
    struct Config {
        IERC20 token;
        address treasury; // receives fees, split remainders and event fees
        address operator; // the only address that can run a loan event (the VRF operator)
        uint256 minDeposit;
        uint256 minWithdraw;
        uint256 maxDeposit; // largest single deposit
        uint256 maxPerUser; // most a user can hold in the contract at once (net of fees)
        uint256 eventFee; // paid by the depositor whose deposit starts a loan event
        uint256 splitUnit;
        uint256 splitOdds;
    }

    /// @notice One energy loan. A loan never moves tokens and never changes a claim.
    struct Loan {
        uint64 lender; // always a live node while the loan is active (a lender split ends it)
        uint64 borrower; // the node that first received it; its parts may now sit in descendants
        uint40 due; // the loan ends at this time even if nobody acts
        bool ended; // repaid early: by a withdrawal from the lender, or by the lender's split
        uint128 amount;
    }

    /// @notice A borrower's part of a loan. A borrower that splits gives each child half.
    struct Borrowed {
        uint64 loanId;
        uint128 amount;
    }

    /// @notice For the app: one active loan part, where it sits, and when it ends.
    struct LoanView {
        uint256 loanId;
        uint256 lender;
        uint256 holder; // the live node holding this part (loansIn) or the first borrower (loansOut)
        uint256 amount;
        uint256 due;
    }

    // ------------------------------------------------------------ constants

    uint256 public constant ROOT = 0;
    uint256 public constant PPM = 1_000_000;
    uint256 public constant WAD = 1e18; // probabilities are scaled to 1e18
    uint32 public constant MAX_FEE_PPM = 10_000; // 1%
    uint32 public constant MAX_ROLL_CAP_PPM = 100_000; // 10%
    uint8 public constant FILL_TOKEN_AMOUNT = 0;
    uint256 public constant MAX_BATCH = 50; // nodes per withdrawAll call
    uint256 public constant MAX_WALK = 128; // past 128 halvings any uint128 claim is zero
    uint32 public constant MAX_EVENT_CHANCE_PPM = 500_000; // 50%
    uint32 public constant MIN_LOAN_SECS = 60;
    uint32 public constant MAX_LOAN_SECS = 1 days;
    uint8 public constant MAX_LOANS_OUT = 4; // hard cap on loansOutCap, so a withdrawal repays at most 4 per node
    uint256 public constant MAX_LOANS_IN = 4; // loan parts a node can hold at once
    uint256 public constant MAX_SENDS = 5; // sends per loan event
    uint256 public constant LOAN_MIN_PPM = 50_000; // a loan is 5% to 20% of the lender's own energy
    uint256 public constant LOAN_MAX_PPM = 200_000;
    uint256 public constant REQUEST_TIMEOUT = 10 minutes; // an unanswered event request expires
    uint256 internal constant MAX_RATIO = 1e27; // fill / mid capped at 1e9 (scaled); chance is the cap there
    uint256 internal constant PPM_TO_WAD = 1e12; // WAD / PPM, exact

    // ------------------------------------------------------------ immutables

    IERC20 public immutable token;
    address public immutable treasury;
    address public immutable operator;
    uint256 public immutable minDeposit;
    uint256 public immutable minWithdraw; // a smaller withdrawal is allowed only when it closes the whole claim
    uint256 public immutable maxDeposit;
    uint256 public immutable maxPerUser;
    uint256 public immutable eventFee;
    uint256 public immutable splitUnit; // halves round down to a multiple of this; 10 = five decimals for USDC
    uint256 public immutable splitOdds; // second layer: a won roll splits 1 time in splitOdds

    // ---------------------------------------------------------------- state

    uint256 public nodeCount;
    uint256 public feesAccrued; // owed to the treasury (fees, split remainders, event fees), sent by sweepFees()
    uint256 public loanCount;
    uint256 public requestCount;
    uint256 public pendingRequest; // the open loan event request; 0 = none
    uint256 public pendingSince;
    uint256 private _nonce;

    /// @notice What each user holds in the contract, net of fees: deposits minus withdrawals.
    /// Used only for the per-user limit. Split rounding can leave a few base units here.
    mapping(address user => uint256) public heldOf;

    mapping(uint256 nodeId => Node) internal _nodes;
    mapping(uint256 nodeId => mapping(address user => Position)) internal _positions;
    mapping(uint256 loanId => Loan) internal _loans;
    mapping(uint256 nodeId => uint64[]) internal _lent; // loan ids, at most MAX_LOANS_OUT
    mapping(uint256 nodeId => Borrowed[]) internal _borrowed; // at most MAX_LOANS_IN
    uint256[] internal _liveIds; // every live node, for picking loan partners at random
    mapping(uint256 nodeId => uint256) internal _liveIndex;

    // --------------------------------------------------------------- events

    event Deposited(uint256 indexed nodeId, address indexed user, uint256 amount, uint256 fee);
    event Withdrawn(uint256 indexed nodeId, address indexed user, uint256 amount, uint256 fee);
    /// @notice A roll won the roll chance and rolled the 1-in-`splitOdds` for a split.
    event SplitRolled(uint256 indexed nodeId, bool split);
    event Split(uint256 indexed parentId, uint256 child0, uint256 child1, uint32 depth);
    event FeesSwept(address indexed treasury, uint256 amount);
    event LoanEventRequested(uint256 indexed requestId, address indexed depositor, uint256 fee);
    event LoanEventRun(uint256 indexed requestId, uint256 sends);
    event LoanMade(
        uint256 indexed loanId, uint256 indexed lender, uint256 indexed borrower, uint256 amount, uint256 due
    );
    event LoanRepaid(uint256 indexed loanId, uint256 indexed lender);

    // --------------------------------------------------------------- errors

    error ZeroAddress();
    error InvalidTraits();
    error InvalidLoanRules();
    error InvalidLimits();
    error InvalidSplitUnit();
    error InvalidSplitOdds();
    error UnknownNode(uint256 nodeId);
    error NodeNotLive(uint256 nodeId);
    error BelowMinDeposit(uint256 amount, uint256 minDeposit);
    error AboveMaxDeposit(uint256 amount, uint256 maxDeposit);
    error AboveUserLimit(uint256 held, uint256 maxPerUser);
    error BelowMinWithdraw(uint256 amount, uint256 minWithdraw);
    error ZeroAmount();
    error InsufficientClaim(uint256 requested, uint256 available);
    error BatchTooLarge(uint256 length, uint256 max);
    error NothingToWithdraw();
    error NotOperator();

    // Slither notes, reviewed: `timestamp` (loan due times and the request timeout compare
    // block.timestamp on purpose; a sequencer can shift it by seconds, which only moves energy);
    // `costly-loop` (every loop is bounded: 5 sends per event, 50 nodes per withdrawAll, at most
    // 4 loans out and 4 loan parts per node). Both are excluded in the slither run for this file.
    // Lint notes, reviewed: the deposit rolls' weak randomness is the documented placeholder;
    // the halving in _split rounds down on purpose and sends the remainder to the treasury;
    // the `% splitOdds == 0` draw is an intended exact match (Slither incorrect-equality);
    // reentrancy-events on Split, SplitRolled and loan events is a false positive: all are emitted
    // before the only external call, the token transfer at the end of deposit.

    // ---------------------------------------------------------- constructor

    constructor(Config memory c, Traits memory rootTraits, LoanRules memory rootLoans) {
        if (address(c.token) == address(0) || c.treasury == address(0) || c.operator == address(0)) {
            revert ZeroAddress();
        }
        if (c.splitUnit == 0) revert InvalidSplitUnit();
        if (c.splitOdds == 0) revert InvalidSplitOdds();
        _validateTraits(rootTraits);
        _validateLoanRules(rootLoans);
        uint256 minDep = c.minDeposit == 0 ? 1 : c.minDeposit;
        if (c.maxDeposit < minDep || c.maxPerUser == 0) revert InvalidLimits();

        token = c.token;
        treasury = c.treasury;
        operator = c.operator;
        minDeposit = minDep;
        minWithdraw = c.minWithdraw == 0 ? 1 : c.minWithdraw;
        maxDeposit = c.maxDeposit;
        maxPerUser = c.maxPerUser;
        eventFee = c.eventFee;
        splitUnit = c.splitUnit;
        splitOdds = c.splitOdds;

        _nodes[ROOT] = Node({
            parent: 0, firstChild: 0, depth: 0, split: false, total: 0, traits: rootTraits, loanRules: rootLoans
        });
        nodeCount = 1;
        _liveIds.push(ROOT);
    }

    // ------------------------------------------------------------- user API

    /// @notice Deposit `amount` into a live node. The fee goes to the treasury; the rest is the
    /// caller's claim. Limits: `amount` at most `maxDeposit`, and the caller's holdings at most
    /// `maxPerUser`. The deposit then rolls the node for a split, and rolls the node's event
    /// chance for a loan event. A deposit that starts a loan event also pays `eventFee`, which
    /// goes to the treasury to pay for the random number.
    function deposit(uint256 nodeId, uint256 amount) external nonReentrant {
        Node storage node = _live(nodeId);
        if (amount < minDeposit) revert BelowMinDeposit(amount, minDeposit);
        if (amount > maxDeposit) revert AboveMaxDeposit(amount, maxDeposit);

        uint256 fee = (amount * node.traits.feePpm) / PPM;
        uint128 credit = (amount - fee).toUint128();
        uint256 held = heldOf[msg.sender] + credit;
        if (held > maxPerUser) revert AboveUserLimit(held, maxPerUser);
        heldOf[msg.sender] = held;

        Position storage pos = _materialize(nodeId, msg.sender);
        pos.own += credit;
        node.total += credit;
        feesAccrued += fee;

        emit Deposited(nodeId, msg.sender, amount, fee);

        uint256 seed = _placeholderSeed(nodeId);
        uint256 charge = amount;
        if (_rollEvent(nodeId, seed)) {
            charge += eventFee;
            feesAccrued += eventFee;
        }
        if (_rollSplit(nodeId, _rollFill(nodeId), node.traits, seed)) {
            _split(nodeId, node);
        }

        token.safeTransferFrom(msg.sender, address(this), charge);
    }

    /// @notice Withdraw `amount` of the caller's claim from a live node, minus the node's fee.
    /// `amount` must be at least `minWithdraw`, unless it is the caller's whole claim.
    /// The withdrawal repays every loan out of the node first. Repaying never reverts.
    function withdraw(uint256 nodeId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _live(nodeId);
        if (amount < minWithdraw && amount != _claim(nodeId, msg.sender)) {
            revert BelowMinWithdraw(amount, minWithdraw);
        }
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

    /// @notice Runs the open loan event with `randomness`. Only the randomness operator can call.
    /// Up to `MAX_SENDS` sends, each from a random live node to a different random live node.
    /// A send that cannot happen (same node, lender at its loan cap or with no energy left,
    /// borrower full) is skipped; the event never reverts on node state. Each send rolls the
    /// borrower for a split with its new roll fill. No tokens move and no claim changes.
    function runLoanEvent(uint256 requestId, uint256 randomness) external nonReentrant {
        if (msg.sender != operator) revert NotOperator();
        if (requestId == 0 || requestId != pendingRequest) return; // stale or answered: nothing to do
        pendingRequest = 0;

        uint256 sends = 0;
        for (uint256 i = 0; i < MAX_SENDS; ++i) {
            uint256 r = uint256(keccak256(abi.encode(randomness, i)));
            uint256 n = _liveIds.length;
            uint256 lender = _liveIds[r % n];
            uint256 borrower = _liveIds[(r >> 64) % n];
            if (_send(lender, borrower, r)) {
                ++sends;
                Node storage b = _nodes[borrower];
                if (_rollSplit(borrower, _rollFill(borrower), b.traits, r >> 128)) {
                    _split(borrower, b);
                }
            }
        }
        emit LoanEventRun(requestId, sends);
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

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    /// @notice Every live node, in no fixed order.
    function liveNodes() external view returns (uint256[] memory) {
        return _liveIds;
    }

    /// @notice A node's energy. `own` is its token total (user claims plus rounding fill).
    /// `lent` and `borrowed` are its active loans out and in. `rollFill` is what the split roll
    /// uses: own minus lent (not below zero), plus borrowed up to that same amount.
    function energyOf(uint256 nodeId)
        external
        view
        returns (uint256 own, uint256 lent, uint256 borrowed, uint256 rollFill)
    {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        own = _nodes[nodeId].total;
        lent = _activeLent(nodeId);
        borrowed = _activeBorrowed(nodeId);
        rollFill = _rollFill(nodeId);
    }

    /// @notice Active loans out of a node. `holder` is the first borrower.
    function loansOut(uint256 nodeId) external view returns (LoanView[] memory out) {
        uint64[] storage ids = _lent[nodeId];
        uint256 k = 0;
        for (uint256 i = 0; i < ids.length; ++i) {
            if (_loanActive(_loans[ids[i]])) ++k;
        }
        out = new LoanView[](k);
        k = 0;
        for (uint256 i = 0; i < ids.length; ++i) {
            Loan storage l = _loans[ids[i]];
            if (!_loanActive(l)) continue;
            out[k++] = LoanView(ids[i], l.lender, l.borrower, l.amount, l.due);
        }
    }

    /// @notice Active loan parts a node holds.
    function loansIn(uint256 nodeId) external view returns (LoanView[] memory out) {
        Borrowed[] storage parts = _borrowed[nodeId];
        uint256 k = 0;
        for (uint256 i = 0; i < parts.length; ++i) {
            if (_loanActive(_loans[parts[i].loanId])) ++k;
        }
        out = new LoanView[](k);
        k = 0;
        for (uint256 i = 0; i < parts.length; ++i) {
            Loan storage l = _loans[parts[i].loanId];
            if (!_loanActive(l)) continue;
            out[k++] = LoanView(parts[i].loanId, l.lender, nodeId, parts[i].amount, l.due);
        }
    }

    /// @notice Layer one: the chance, scaled to 1e18, that a roll at `fill` gets to roll for a
    /// split. For the UI.
    function rollChance(uint256 nodeId, uint256 fill) external view returns (uint256) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        return _rollChance(fill, _nodes[nodeId].traits);
    }

    /// @notice Both layers: the chance, scaled to 1e18, that a roll at `fill` splits the node.
    function splitChance(uint256 nodeId, uint256 fill) public view virtual returns (uint256) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        return _rollChance(fill, _nodes[nodeId].traits) / splitOdds;
    }

    /// @notice The chance, in parts per million, that a deposit into `nodeId` starts a loan event.
    function eventChancePpm(uint256 nodeId) public view virtual returns (uint256) {
        if (nodeId >= nodeCount) revert UnknownNode(nodeId);
        return _nodes[nodeId].loanRules.eventChancePpm;
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

    /// @dev Removes `amount` from the user's claim and the node's total, and repays every loan
    /// out of the node. Returns the payout and the fee; the caller adds the fee to
    /// `feesAccrued` once, outside any loop. Loans never affect what is paid.
    function _take(uint256 nodeId, address user, uint256 amount) internal returns (uint256 payout, uint256 fee) {
        Node storage node = _live(nodeId);
        Position storage pos = _materialize(nodeId, user);
        if (amount > pos.own) revert InsufficientClaim(amount, pos.own);

        uint128 a = amount.toUint128();
        pos.own -= a;
        node.total -= a; // node.total >= every claim in it, so this cannot underflow
        uint256 held = heldOf[user];
        heldOf[user] = held > amount ? held - amount : 0;

        _repayAll(nodeId);

        fee = (amount * node.traits.feePpm) / PPM;
        payout = amount - fee;

        emit Withdrawn(nodeId, user, amount, fee);
    }

    /// @dev Ends every loan out of `nodeId`. At most MAX_LOANS_OUT entries. Writes only flags:
    /// no checks that can fail, no external calls, so it can never block a withdrawal.
    function _repayAll(uint256 nodeId) internal {
        uint64[] storage ids = _lent[nodeId];
        uint256 len = ids.length;
        for (uint256 i = 0; i < len; ++i) {
            Loan storage l = _loans[ids[i]];
            if (_loanActive(l)) {
                l.ended = true;
                // forge-lint: disable-next-line(reentrancy-events)
                emit LoanRepaid(ids[i], nodeId);
            }
        }
        delete _lent[nodeId];
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
    ///    to the treasury under rule 2.
    ///
    /// Loans, energy only (no tokens move, no claim changes):
    /// 5. Every loan out of the parent ends (the lender's energy splits; its loans come home).
    /// 6. Every active loan part the parent holds splits in two: the first child gets the larger
    ///    half (the odd base unit), the second the rest, so the parts still sum to the loan.
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

        Node memory child = Node({
            parent: parent,
            firstChild: 0,
            depth: depth,
            split: false,
            total: half,
            traits: node.traits,
            loanRules: node.loanRules
        });
        _nodes[c0] = child;
        _nodes[c0 + 1] = child;

        _repayAll(nodeId);
        Borrowed[] storage parts = _borrowed[nodeId];
        for (uint256 i = 0; i < parts.length; ++i) {
            Borrowed memory p = parts[i];
            if (!_loanActive(_loans[p.loanId])) continue;
            uint128 second = p.amount / 2;
            uint128 first = p.amount - second;
            if (first != 0) _borrowed[c0].push(Borrowed(p.loanId, first));
            if (second != 0) _borrowed[c0 + 1].push(Borrowed(p.loanId, second));
        }
        delete _borrowed[nodeId];

        _removeLive(nodeId);
        _addLive(c0);
        _addLive(c0 + 1);

        // forge-lint: disable-next-line(reentrancy-events)
        emit Split(nodeId, c0, c0 + 1, depth);
    }

    /// @dev One send from `lender` to `borrower`, or nothing. Never reverts on node state.
    /// The amount is 5% to 20% of the lender's own energy that is not already lent.
    function _send(uint256 lender, uint256 borrower, uint256 r) internal returns (bool) {
        if (lender == borrower) return false;
        Node storage ln = _nodes[lender];
        if (_pruneLent(lender) >= ln.loanRules.loansOutCap) return false;
        if (_pruneBorrowed(borrower) >= MAX_LOANS_IN) return false;

        uint256 own = ln.total;
        uint256 lent = _activeLent(lender);
        if (own <= lent) return false;
        uint256 ppm = LOAN_MIN_PPM + ((r >> 160) % (LOAN_MAX_PPM - LOAN_MIN_PPM + 1));
        uint256 amount = ((own - lent) * ppm) / PPM;
        if (amount == 0) return false;

        LoanRules memory rules = ln.loanRules;
        uint256 span = uint256(rules.loanMaxSecs) - rules.loanMinSecs + 1;
        uint256 due = block.timestamp + rules.loanMinSecs + ((r >> 200) % span);

        uint256 id = ++loanCount;
        _loans[id] = Loan({
            lender: lender.toUint64(),
            borrower: borrower.toUint64(),
            due: due.toUint40(),
            ended: false,
            amount: amount.toUint128()
        });
        _lent[lender].push(id.toUint64());
        _borrowed[borrower].push(Borrowed(id.toUint64(), amount.toUint128()));
        // forge-lint: disable-next-line(reentrancy-events)
        emit LoanMade(id, lender, borrower, amount, due);
        return true;
    }

    /// @dev Drops ended and past-due loans from a lender's list. Returns how many stay active.
    function _pruneLent(uint256 nodeId) internal returns (uint256) {
        uint64[] storage ids = _lent[nodeId];
        uint256 i = 0;
        while (i < ids.length) {
            if (_loanActive(_loans[ids[i]])) {
                ++i;
            } else {
                ids[i] = ids[ids.length - 1];
                ids.pop();
            }
        }
        return ids.length;
    }

    /// @dev Drops parts of ended and past-due loans from a borrower's list. Returns how many stay.
    function _pruneBorrowed(uint256 nodeId) internal returns (uint256) {
        Borrowed[] storage parts = _borrowed[nodeId];
        uint256 i = 0;
        while (i < parts.length) {
            if (_loanActive(_loans[parts[i].loanId])) {
                ++i;
            } else {
                parts[i] = parts[parts.length - 1];
                parts.pop();
            }
        }
        return parts.length;
    }

    function _loanActive(Loan storage l) internal view returns (bool) {
        // slither-disable-next-line timestamp
        return !l.ended && l.due > block.timestamp;
    }

    function _activeLent(uint256 nodeId) internal view returns (uint256 sum) {
        uint64[] storage ids = _lent[nodeId];
        for (uint256 i = 0; i < ids.length; ++i) {
            Loan storage l = _loans[ids[i]];
            if (_loanActive(l)) sum += l.amount;
        }
    }

    function _activeBorrowed(uint256 nodeId) internal view returns (uint256 sum) {
        Borrowed[] storage parts = _borrowed[nodeId];
        for (uint256 i = 0; i < parts.length; ++i) {
            if (_loanActive(_loans[parts[i].loanId])) sum += parts[i].amount;
        }
    }

    /// @dev The fill the split roll uses: own energy not lent out, plus borrowed energy up to
    /// that same amount. Borrowed energy is therefore at most 50% of the roll fill.
    function _rollFill(uint256 nodeId) internal view returns (uint256) {
        uint256 own = _nodes[nodeId].total;
        uint256 lent = _activeLent(nodeId);
        uint256 base = own > lent ? own - lent : 0;
        uint256 borrowed = _activeBorrowed(nodeId);
        return base + (borrowed < base ? borrowed : base);
    }

    function _addLive(uint256 nodeId) internal {
        _liveIndex[nodeId] = _liveIds.length;
        _liveIds.push(nodeId);
    }

    function _removeLive(uint256 nodeId) internal {
        uint256 i = _liveIndex[nodeId];
        uint256 last = _liveIds[_liveIds.length - 1];
        _liveIds[i] = last;
        _liveIndex[last] = i;
        _liveIds.pop();
        delete _liveIndex[nodeId];
    }

    /// @dev PLACEHOLDER randomness from block data for the two rolls inside a deposit:
    /// predictable and gameable by a contract caller that reverts on an unwanted result.
    /// Replace before real funds. The loan event itself uses the operator's random number.
    function _placeholderSeed(uint256 nodeId) internal returns (uint256) {
        return uint256(keccak256(abi.encode(block.prevrandao, block.number, nodeId, msg.sender, _nonce++)));
    }

    /// @dev Rolls the node's event chance. A win opens a loan event request, unless one is
    /// already open and younger than REQUEST_TIMEOUT. An unanswered request expires, so a
    /// silent operator never blocks deposits or withdrawals.
    function _rollEvent(uint256 nodeId, uint256 seed) internal virtual returns (bool) {
        // slither-disable-next-line timestamp
        if (pendingRequest != 0 && block.timestamp < pendingSince + REQUEST_TIMEOUT) return false;
        if (uint256(keccak256(abi.encode(seed, 3))) % PPM >= eventChancePpm(nodeId)) return false;
        uint256 id = ++requestCount;
        pendingRequest = id;
        pendingSince = block.timestamp;
        // forge-lint: disable-next-line(reentrancy-events)
        emit LoanEventRequested(id, msg.sender, eventFee);
        return true;
    }

    /// @dev Layer one, the roll-chance curve, scaled to 1e18:
    ///     chance = cap * r^2 / (r^2 + 1),  where r = fill / rollMidFill.
    /// With cap 10% and midpoint 300 USDC: 1 USDC -> 0.0001%, 100 USDC -> 1%, 300 USDC -> 5%,
    /// 1,000 USDC -> about 9.2%.
    function _rollChance(uint256 fill, Traits memory t) internal pure returns (uint256) {
        if (fill == 0) return 0;
        uint256 r = Math.mulDiv(fill, WAD, t.rollMidFill);
        if (r > MAX_RATIO) r = MAX_RATIO;
        uint256 r2 = r * r; // at most 1e54
        return Math.mulDiv(uint256(t.rollCapPpm) * PPM_TO_WAD, r2, r2 + WAD * WAD);
    }

    /// @dev The split roll, in two layers with separate draws from `seed`: layer one passes with
    /// the curve's chance, then layer two splits 1 time in `splitOdds`.
    function _rollSplit(uint256 nodeId, uint256 fill, Traits memory t, uint256 seed) internal virtual returns (bool) {
        if (uint256(keccak256(abi.encode(seed, 1))) % WAD >= _rollChance(fill, t)) return false;
        // slither-disable-next-line incorrect-equality
        bool hit = uint256(keccak256(abi.encode(seed, 2))) % splitOdds == 0;
        // forge-lint: disable-next-line(reentrancy-events)
        emit SplitRolled(nodeId, hit);
        return hit;
    }

    function _validateTraits(Traits memory t) internal pure {
        if (
            t.feePpm > MAX_FEE_PPM || t.fillMeasure != FILL_TOKEN_AMOUNT || t.rollCapPpm > MAX_ROLL_CAP_PPM
                || t.rollMidFill == 0
        ) {
            revert InvalidTraits();
        }
    }

    function _validateLoanRules(LoanRules memory r) internal pure {
        if (
            r.eventChancePpm > MAX_EVENT_CHANCE_PPM || r.loanMinSecs < MIN_LOAN_SECS || r.loanMaxSecs > MAX_LOAN_SECS
                || r.loanMinSecs > r.loanMaxSecs || r.loansOutCap == 0 || r.loansOutCap > MAX_LOANS_OUT
        ) {
            revert InvalidLoanRules();
        }
    }
}
