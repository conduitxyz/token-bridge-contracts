// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.4;

import "./L2ArbitrumGateway.sol";
import {IAUSD, IAgoraProxyAdmin} from "../../libraries/IAUSD.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title  Child chain custom gateway for AUSD implementing Bridged AUSD Standard.
 *
 * @dev    This contract can be used on new Orbit chains which want to provide AUSD
 *         bridging solution and keep the possibility to upgrade to native AUSD at
 *         some point later.
 *
 *         Parent chain custom gateway to be used along this child chain custom gateway is
 *         L1AUSDGateway (when eth is used to pay fees) or L1OrbitAUSDGateway (when custom fee token is used).
 *         This custom gateway differs from standard gateway in the following ways:
 *         - it supports a single parent chain - child chain AUSD token pair
 *         - it is ownable
 *         - withdrawals can be paused by the owner
 *         - owner can set an "transferrer" account which will be able to transfer AUSD ownership
 *         - transferrer can transfer AUSD owner and proxyAdmin
 *
 *         NOTE: before withdrawing funds, make sure that recipient address is not frozen on the parent chain.
 *               Also, make sure that AUSD token itself is not paused. Otherwise funds might get stuck.
 */
contract L2AUSDGateway is L2ArbitrumGateway {
    using SafeERC20 for IERC20;
    using Address for address;

    address public l1AUSD;
    address public l2AUSD;
    address public owner;
    address public ausdOwnershipTransferrer;
    bool public withdrawalsPaused;

    event WithdrawalsPaused();
    event WithdrawalsUnpaused();
    event OwnerSet(address indexed owner);
    event AUSDOwnershipTransferrerSet(address indexed ausdOwnershipTransferrer);
    event AUSDOwnershipTransferred(address indexed newOwner, address indexed newProxyAdmin);

    error L2AUSDGateway_WithdrawalsAlreadyPaused();
    error L2AUSDGateway_WithdrawalsAlreadyUnpaused();
    error L2AUSDGateway_WithdrawalsPaused();
    error L2AUSDGateway_InvalidL1AUSD();
    error L2AUSDGateway_InvalidL2AUSD();
    error L2AUSDGateway_NotOwner();
    error L2AUSDGateway_InvalidOwner();
    error L2AUSDGateway_NotAUSDOwnershipTransferrer();

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert L2AUSDGateway_NotOwner();
        }
        _;
    }

    function initialize(
        address _l1Counterpart,
        address _router,
        address _l1AUSD,
        address _l2AUSD,
        address _owner
    ) public {
        if (_l1AUSD == address(0)) {
            revert L2AUSDGateway_InvalidL1AUSD();
        }
        if (_l2AUSD == address(0)) {
            revert L2AUSDGateway_InvalidL2AUSD();
        }
        if (_owner == address(0)) {
            revert L2AUSDGateway_InvalidOwner();
        }
        L2ArbitrumGateway._initialize(_l1Counterpart, _router);
        l1AUSD = _l1AUSD;
        l2AUSD = _l2AUSD;
        owner = _owner;
    }

    /**
     * @notice Pause all withdrawals. This can only be called by the owner.
     */
    function pauseWithdrawals() external onlyOwner {
        if (withdrawalsPaused) {
            revert L2AUSDGateway_WithdrawalsAlreadyPaused();
        }
        withdrawalsPaused = true;
        emit WithdrawalsPaused();
    }

    /**
     * @notice Unpause withdrawals. This can only be called by the owner.
     */
    function unpauseWithdrawals() external onlyOwner {
        if (!withdrawalsPaused) {
            revert L2AUSDGateway_WithdrawalsAlreadyUnpaused();
        }
        withdrawalsPaused = false;
        emit WithdrawalsUnpaused();
    }

    /**
     * @notice Sets a new owner.
     */
    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert L2AUSDGateway_InvalidOwner();
        }
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    /**
     * @notice Sets the account which is able to transfer AUSD role away from the gateway to some other account.
     */
    function setAusdOwnershipTransferrer(address _ausdOwnershipTransferrer) external onlyOwner {
        ausdOwnershipTransferrer = _ausdOwnershipTransferrer;
        emit AUSDOwnershipTransferrerSet(_ausdOwnershipTransferrer);
    }

    /**
     * @notice In accordance with bridged AUSD standard, the ownership of the AUSD token contract is transferred
     *         to the new owner, and the proxy admin is transferred to the caller (ausdOwnershipTransferrer).
     * @dev    For transfer to be successful, this gateway should be both the owner and the proxy admin of L2 AUSD token.
     */
    function transferAUSDRoles(address _owner) external {
        if (msg.sender != ausdOwnershipTransferrer) {
            revert L2AUSDGateway_NotAUSDOwnershipTransferrer();
        }

        // Transfer ProxyAdmin ownership to the transferrer (msg.sender)
        address proxyAdmin = IAUSD(l2AUSD).proxyAdminAddress();
        IAgoraProxyAdmin(proxyAdmin).transferOwnership(msg.sender);
        
        // Transfer ADMIN_ROLE to the new owner
        IAUSD(l2AUSD).transferRole(IAUSD(l2AUSD).ADMIN_ROLE(), _owner);

        emit AUSDOwnershipTransferred(_owner, msg.sender);
    }

    /**
     * @notice Entrypoint for withdrawing AUSD, can be used only if withdrawals are not paused.
     */
    function outboundTransfer(
        address _l1Token,
        address _to,
        uint256 _amount,
        uint256, /* _maxGas */
        uint256, /* _gasPriceBid */
        bytes calldata _data
    ) public payable override returns (bytes memory res) {
        if (withdrawalsPaused) {
            revert L2AUSDGateway_WithdrawalsPaused();
        }
        return super.outboundTransfer(_l1Token, _to, _amount, 0, 0, _data);
    }

    /**
     * @notice Only parent chain - child chain AUSD token pair is supported
     */
    function calculateL2TokenAddress(address l1ERC20) public view override returns (address) {
        if (l1ERC20 != l1AUSD) {
            // invalid L1 ausd address
            return address(0);
        }
        return l2AUSD;
    }

    function inboundEscrowTransfer(address _l2Address, address _dest, uint256 _amount)
        internal
        override
    {
        IAUSD.BatchMintParam[] memory mints = new IAUSD.BatchMintParam[](1);
        mints[0] = IAUSD.BatchMintParam({
            receiverAddress: _dest,
            value: _amount
        });
        IAUSD(_l2Address).batchMint(mints);
    }

    function outboundEscrowTransfer(address _l2Token, address _from, uint256 _amount)
        internal
        override
        returns (uint256)
    {
        // fetch the AUSD tokens from the user and then burn them
        IERC20(_l2Token).safeTransferFrom(_from, address(this), _amount);
        
        IAUSD.BatchBurnFromParam[] memory burns = new IAUSD.BatchBurnFromParam[](1);
        burns[0] = IAUSD.BatchBurnFromParam({
            burnFromAddress: address(this),
            value: _amount
        });
        IAUSD(_l2Token).batchBurnFrom(burns);

        return _amount;
    }

    /**
     * @notice Withdraw back the AUSD if child chain side is not set up properly
     */
    function handleNoContract(
        address l1ERC20,
        address, /* expectedL2Address */
        address _from,
        address, /* _to */
        uint256 _amount,
        bytes memory /* deployData */
    ) internal override returns (bool shouldHalt) {
        // it is assumed that the custom token is deployed to child chain before deposits are made
        triggerWithdrawal(l1ERC20, address(this), _from, _amount, "");
        return true;
    }

    /**
     * @notice We need to override this function because base implementation assumes that L2 token implements
     *         `l1Address()` function from IArbToken interface. In the case of AUSD gateway IArbToken logic is
     *         part of this contract, so we just check that addresses match the expected L1 and L2 AUSD address.
     */
    function _isValidTokenAddress(address _l1Address, address _expectedL2Address)
        internal
        view
        override
        returns (bool)
    {
        return _l1Address == l1AUSD && _expectedL2Address == l2AUSD;
    }
}
