// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Evolution} from "../Evolution.sol";

/// @notice LOCAL TEST CHAIN ONLY. Evolution plus two test dials that anyone can set, so the demo
/// app can change the split chance and the loan event chance while testing animations and UI.
/// The production contract has no dials and no setters. DeployLocal refuses any chain but 31337.
contract EvolutionDemo is Evolution {
    /// @notice 0 = use the real rules. Otherwise the chance, in parts per million, that each roll
    /// splits its node (one layer, no curve, no 1-in-`splitOdds`).
    uint32 public demoSplitPpm;
    /// @notice 0 = use each node's event chance. Otherwise the chance, in parts per million, that a
    /// deposit starts a loan event. 1 = never (the dial's floor).
    uint32 public demoEventPpm;

    event DemoDials(uint32 splitPpm, uint32 eventPpm);

    constructor(Config memory c, Traits memory t, LoanRules memory r) Evolution(c, t, r) {
        require(block.chainid == 31337, "local chain only");
    }

    function setDemoDials(uint32 splitPpm, uint32 eventPpm) external {
        require(splitPpm <= PPM && eventPpm <= PPM, "ppm");
        demoSplitPpm = splitPpm;
        demoEventPpm = eventPpm;
        emit DemoDials(splitPpm, eventPpm);
    }

    function splitChance(uint256 nodeId, uint256 fill) public view override returns (uint256) {
        if (demoSplitPpm == 0) return super.splitChance(nodeId, fill);
        return uint256(demoSplitPpm) * 1e12;
    }

    function eventChancePpm(uint256 nodeId) public view override returns (uint256) {
        if (demoEventPpm == 0) return super.eventChancePpm(nodeId);
        return demoEventPpm == 1 ? 0 : demoEventPpm;
    }

    function _rollSplit(uint256 nodeId, uint256 fill, Traits memory t, uint256 seed) internal override returns (bool) {
        if (demoSplitPpm == 0) return super._rollSplit(nodeId, fill, t, seed);
        bool hit = uint256(keccak256(abi.encode(seed, 1))) % PPM < demoSplitPpm;
        emit SplitRolled(nodeId, hit);
        return hit;
    }
}
