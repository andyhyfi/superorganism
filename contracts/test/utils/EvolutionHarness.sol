// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../../src/Evolution.sol";

/// @notice Test-only subclass. Lets a test force the split roll and the event roll, and exposes
/// the real roll for statistical checks. Never deployed.
contract EvolutionHarness is Evolution {
    enum Mode {
        Real,
        Never,
        Always
    }

    address public constant OPERATOR = address(0x0FE7);

    Mode public mode;
    Mode public eventMode = Mode.Never;

    /// @dev The v1 constructor shape: no deposit limits, no event fee, events off unless forced.
    constructor(
        IERC20 token_,
        address treasury_,
        uint256 minDeposit_,
        uint256 minWithdraw_,
        uint256 splitUnit_,
        uint256 splitOdds_,
        Traits memory traits_
    )
        Evolution(
            Config({
                token: token_,
                treasury: treasury_,
                operator: OPERATOR,
                minDeposit: minDeposit_,
                minWithdraw: minWithdraw_,
                maxDeposit: type(uint128).max,
                maxPerUser: type(uint256).max,
                eventFee: 0,
                splitUnit: splitUnit_,
                splitOdds: splitOdds_
            }),
            traits_,
            LoanRules({eventChancePpm: 150_000, loanMinSecs: 5 minutes, loanMaxSecs: 60 minutes, loansOutCap: 1})
        )
    {}

    function setMode(Mode m) external {
        mode = m;
    }

    function setEventMode(Mode m) external {
        eventMode = m;
    }

    function exposedHalf(uint256 x) external view returns (uint256) {
        return _half(x);
    }

    function exposedRollFill(uint256 nodeId) external view returns (uint256) {
        return _rollFill(nodeId);
    }

    /// @dev Runs the real two-layer roll for `fill` on the root's traits, without depositing.
    function exposedRoll(uint256 fill) external returns (bool) {
        return Evolution._rollSplit(ROOT, fill, _nodes[ROOT].traits, _placeholderSeed(ROOT));
    }

    function _rollSplit(uint256 nodeId, uint256 fill, Traits memory t, uint256 seed) internal override returns (bool) {
        if (mode == Mode.Never) return false;
        if (mode == Mode.Always) return true;
        return super._rollSplit(nodeId, fill, t, seed);
    }

    function _rollEvent(uint256 nodeId, uint256 seed) internal override returns (bool) {
        if (eventMode == Mode.Never) return false;
        if (eventMode == Mode.Always) {
            if (pendingRequest != 0 && block.timestamp < pendingSince + REQUEST_TIMEOUT) return false;
            uint256 id = ++requestCount;
            pendingRequest = id;
            pendingSince = block.timestamp;
            emit LoanEventRequested(id, msg.sender, eventFee);
            return true;
        }
        return super._rollEvent(nodeId, seed);
    }
}
