// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.0;

import {L1AUSDGateway} from "./L1AUSDGateway.sol";
import {IERC20Inbox} from "../L1ArbitrumMessenger.sol";
import {IERC20Bridge} from "../../libraries/IERC20Bridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Custom gateway for AUSD implementing Bridged AUSD Standard.
 *
 * @dev    This contract can be used on new Orbit chains which want to provide AUSD
 *         bridging solution and keep the possibility to upgrade to native AUSD at
 *         some point later.
 *
 *         Child chain custom gateway to be used along this parent chain custom gateway is L2AUSDGateway.
 *         This custom gateway differs from standard gateway in the following ways:
 *         - it supports a single parent chain - child chain AUSD token pair
 *         - it is ownable
 *         - owner can pause and unpause deposits
 *         - owner can set a burner address
 *         - owner can set the amount of AUSD tokens to be burned by burner
 *         - burner can trigger burning the amount of AUSD tokens locked in the gateway that matches the L2 supply
 *
 *         This contract is to be used on chains where custom fee token is used. If chain is using
 *         ETH as native token then use L1AUSDGateway instead.
 */
contract L1OrbitAUSDGateway is L1AUSDGateway {
    using SafeERC20 for IERC20;

    function _parseUserEncodedData(bytes memory data)
        internal
        pure
        override
        returns (uint256 maxSubmissionCost, bytes memory callHookData, uint256 tokenTotalFeeAmount)
    {
        (maxSubmissionCost, callHookData, tokenTotalFeeAmount) =
            abi.decode(data, (uint256, bytes, uint256));
    }

    function _initiateDeposit(
        address _refundTo,
        address _from,
        uint256, // _amount, this info is already contained in _data
        uint256 _maxGas,
        uint256 _gasPriceBid,
        uint256 _maxSubmissionCost,
        uint256 tokenTotalFeeAmount,
        bytes memory _data
    ) internal override returns (uint256) {
        return sendTxToL2CustomRefund(
            inbox,
            counterpartGateway,
            _refundTo,
            _from,
            tokenTotalFeeAmount,
            0,
            L2GasParams({
                _maxSubmissionCost: _maxSubmissionCost,
                _maxGas: _maxGas,
                _gasPriceBid: _gasPriceBid
            }),
            _data
        );
    }

    function _createRetryable(
        address _inbox,
        address _to,
        address _refundTo,
        address _user,
        uint256 _totalFeeAmount,
        uint256 _l2CallValue,
        uint256 _maxSubmissionCost,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes memory _data
    ) internal override returns (uint256) {
        {
            // Transfer native token amount needed to pay for retryable fees to the inbox.
            // Fee tokens will be transferred from user who initiated the action - that's `_user` account in
            // case call was routed by router, or msg.sender in case gateway's entrypoint was called directly.
            address nativeFeeToken = IERC20Bridge(address(getBridge(_inbox))).nativeToken();
            uint256 inboxNativeTokenBalance = IERC20(nativeFeeToken).balanceOf(_inbox);
            if (inboxNativeTokenBalance < _totalFeeAmount) {
                address transferFrom = isRouter(msg.sender) ? _user : msg.sender;
                IERC20(nativeFeeToken).safeTransferFrom(
                    transferFrom, _inbox, _totalFeeAmount - inboxNativeTokenBalance
                );
            }
        }

        return IERC20Inbox(_inbox).createRetryableTicket(
            _to,
            _l2CallValue,
            _maxSubmissionCost,
            _refundTo,
            _user,
            _maxGas,
            _gasPriceBid,
            _totalFeeAmount,
            _data
        );
    }
}
