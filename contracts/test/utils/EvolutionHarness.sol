// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Evolution} from "../../src/Evolution.sol";

/// @notice Test-only subclass. Lets a test force the split roll, and exposes the real roll for
/// statistical checks. Never deployed.
contract EvolutionHarness is Evolution {
    enum Mode {
        Real,
        Never,
        Always
    }

    Mode public mode;

    constructor(IERC20 token_, address treasury_, uint256 minDeposit_, uint256 splitUnit_, Traits memory traits_)
        Evolution(token_, treasury_, minDeposit_, splitUnit_, traits_)
    {}

    function setMode(Mode m) external {
        mode = m;
    }

    function exposedHalf(uint256 x) external view returns (uint256) {
        return _half(x);
    }

    function _rollSplit(uint256 nodeId, uint256 fill, uint256 halfFill) internal override returns (bool) {
        if (mode == Mode.Never) return false;
        if (mode == Mode.Always) return true;
        return super._rollSplit(nodeId, fill, halfFill);
    }
}
