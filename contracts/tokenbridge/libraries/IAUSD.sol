// SPDX-License-Identifier: MIT
pragma solidity 0.8.21;

interface IAUSD {
    struct BatchMintParam {
        address receiverAddress;
        uint256 value;
    }
    
    struct BatchBurnFromParam {
        address burnFromAddress;
        uint256 value;
    }
    
    function batchMint(BatchMintParam[] memory _mints) external;
    function batchBurnFrom(BatchBurnFromParam[] memory _burns) external;
    function isAccountFrozen(address _account) external view returns (bool);
    function isMintPaused() external view returns (bool);
    function isTransferPaused() external view returns (bool);
    function minterAddress() external view returns (address);
    function adminAddress() external view returns (address);
    function proxyAdminAddress() external view returns (address);
    
    // ERC20 functions needed
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    
    // RBAC functions
    function transferRole(bytes32 role, address newAddress) external;
    function acceptTransferRole(bytes32 role) external;
    function ADMIN_ROLE() external view returns (bytes32);
    function MINTER_ROLE() external view returns (bytes32);
}

interface IAgoraProxyAdmin {
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}

