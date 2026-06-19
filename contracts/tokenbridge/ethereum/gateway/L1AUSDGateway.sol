// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.4;

import {
    L1ArbitrumExtendedGateway,
    L1ArbitrumGateway,
    ITokenGateway,
    TokenGateway
} from "./L1ArbitrumExtendedGateway.sol";
import {IAUSD} from "../../libraries/IAUSD.sol";

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
 *         - owner can set the amount of AUSD tokens to be burned by burner. Owner is trusted to this correctly and not frontrun the burning.
 *         - burner can trigger burning the amount of AUSD tokens locked in the gateway that matches the L2 supply
 *
 *         This contract is to be used on chains where ETH is the native token. If chain is using
 *         custom fee token then use L1OrbitAUSDGateway instead.
 *
 *         NOTE: before depositing funds, make sure that recipient address is not frozen on the child chain.
 *               Also, make sure that AUSD token itself is not paused. Otherwise funds might get stuck.
 */
contract L1AUSDGateway is L1ArbitrumExtendedGateway {
    address public l1AUSD;
    address public l2AUSD;
    address public owner;
    address public burner;
    bool public depositsPaused;
    uint256 public burnAmount;

    event DepositsPaused();
    event DepositsUnpaused();
    event GatewayAusdBurned(uint256 amount);
    event BurnerSet(address indexed burner);
    event BurnAmountSet(uint256 amount);

    error L1AUSDGateway_DepositsAlreadyPaused();
    error L1AUSDGateway_DepositsAlreadyUnpaused();
    error L1AUSDGateway_DepositsPaused();
    error L1AUSDGateway_DepositsNotPaused();
    error L1AUSDGateway_InvalidL1AUSD();
    error L1AUSDGateway_InvalidL2AUSD();
    error L1AUSDGateway_NotOwner();
    error L1AUSDGateway_InvalidOwner();
    error L1AUSDGateway_NotBurner();
    error L1AUSDGateway_BurnAmountNotSet();

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert L1AUSDGateway_NotOwner();
        }
        _;
    }

    function initialize(
        address _l2Counterpart,
        address _l1Router,
        address _inbox,
        address _l1AUSD,
        address _l2AUSD,
        address _owner
    ) public {
        if (_l1AUSD == address(0)) {
            revert L1AUSDGateway_InvalidL1AUSD();
        }
        if (_l2AUSD == address(0)) {
            revert L1AUSDGateway_InvalidL2AUSD();
        }
        if (_owner == address(0)) {
            revert L1AUSDGateway_InvalidOwner();
        }
        L1ArbitrumGateway._initialize(_l2Counterpart, _l1Router, _inbox);
        l1AUSD = _l1AUSD;
        l2AUSD = _l2AUSD;
        owner = _owner;
    }

    /**
     * @notice Pauses deposits. This can only be called by the owner.
     * @dev    Pausing is prerequisite for burning escrowed AUSD tokens.  Incoming withdrawals are not affected.
     *         Pausing the withdrawals needs to be done separately on the child chain.
     */
    function pauseDeposits() external onlyOwner {
        if (depositsPaused) {
            revert L1AUSDGateway_DepositsAlreadyPaused();
        }
        depositsPaused = true;
        emit DepositsPaused();
    }

    /**
     * @notice Unpauses deposits. This can only be called by the owner.
     */
    function unpauseDeposits() external onlyOwner {
        if (!depositsPaused) {
            revert L1AUSDGateway_DepositsAlreadyUnpaused();
        }
        depositsPaused = false;

        emit DepositsUnpaused();
    }

    /**
     * @notice Owner sets a new burner.
     */
    function setBurner(address newBurner) external onlyOwner {
        burner = newBurner;
        emit BurnerSet(newBurner);
    }

    /**
     * @notice Owner sets the amount of AUSD tokens to be burned by burner account.
     * @dev    This amount should match the L2 supply of bridged AUSD. But it's not enforced, so burner
     *         should verify that correct amount is set before proceeding with burning.
     */
    function setBurnAmount(uint256 _burnAmount) external onlyOwner {
        burnAmount = _burnAmount;
        emit BurnAmountSet(_burnAmount);
    }

    /**
     * @notice Burns the AUSD tokens escrowed in the gateway.
     * @dev    Can be called by burner when deposits are paused and when owner has set the burn amount.
     *         Owner is trusted to correctly set the burn amount and to not frontrun the burning by
     *         modifying the burn amount.
     */
    function burnLockedAUSD() external {
        if (msg.sender != burner) {
            revert L1AUSDGateway_NotBurner();
        }
        if (!depositsPaused) {
            revert L1AUSDGateway_DepositsNotPaused();
        }
        uint256 _burnAmount = burnAmount;
        if (_burnAmount == 0) {
            revert L1AUSDGateway_BurnAmountNotSet();
        }

        burnAmount = 0;
        
        IAUSD.BatchBurnFromParam[] memory burns = new IAUSD.BatchBurnFromParam[](1);
        burns[0] = IAUSD.BatchBurnFromParam({
            burnFromAddress: address(this),
            value: _burnAmount
        });
        IAUSD(l1AUSD).batchBurnFrom(burns);
        
        emit GatewayAusdBurned(_burnAmount);
    }

    /**
     * @notice Sets a new owner.
     */
    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert L1AUSDGateway_InvalidOwner();
        }
        owner = newOwner;
    }

    /**
     * @notice entrypoint for depositing AUSD, can be used only if deposits are not paused.
     */
    function outboundTransferCustomRefund(
        address _l1Token,
        address _refundTo,
        address _to,
        uint256 _amount,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes calldata _data
    ) public payable override returns (bytes memory res) {
        if (depositsPaused) {
            revert L1AUSDGateway_DepositsPaused();
        }
        return super.outboundTransferCustomRefund(
            _l1Token, _refundTo, _to, _amount, _maxGas, _gasPriceBid, _data
        );
    }

    /**
     * @notice only parent chain - child chain AUSD token pair is supported
     */
    function calculateL2TokenAddress(address l1ERC20)
        public
        view
        override(ITokenGateway, TokenGateway)
        returns (address)
    {
        if (l1ERC20 != l1AUSD) {
            // invalid L1 AUSD address
            return address(0);
        }
        return l2AUSD;
    }
}
