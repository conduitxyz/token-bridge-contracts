import * as fs from 'fs'
import { ethers } from 'hardhat'
import { BigNumber, Contract, ContractTransaction, Overrides, Wallet } from 'ethers'
import { JsonRpcProvider, Provider } from '@ethersproject/providers'
import {
  ERC20__factory,
  IBridge__factory,
  IERC20__factory,
  IERC20Bridge__factory,
  IInboxBase__factory,
  L1GatewayRouter__factory,
  L1OrbitGatewayRouter__factory,
  L2GatewayRouter__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
  UpgradeExecutor__factory,
} from '../../build/types'
import {
  L1AUSDGateway,
  L1AUSDGateway__factory,
  L1OrbitAUSDGateway,
  L1OrbitAUSDGateway__factory,
  L2AUSDGateway,
  L2AUSDGateway__factory,
} from '../../build/types'

import {
  L1Network,
  L2Network,
  L1ToL2MessageGasEstimator,
  L1ToL2MessageStatus,
  L1TransactionReceipt,
  addCustomNetwork,
} from '@arbitrum/sdk'
import { RollupAdminLogic__factory } from '@arbitrum/sdk/dist/lib/abi/factories/RollupAdminLogic__factory'
import { getBaseFee } from '@arbitrum/sdk/dist/lib/utils/lib'
import * as dotenv from 'dotenv'

dotenv.config()

const REGISTRATION_TX_FILE = '/Users/dhruvagarwal/Developer/conduit/token-bridge-contracts/scripts/ausd-bridge-deployment/config/registerAusdGatewayTx.json'

main().then(() => console.log('Done.'))

/**
 * AUSD bridge deployment script. Script will do the following:
 * - load deployer wallets for L1 and L2
 * - register L1 and L2 networks in SDK
 * - deploy new L1 and L2 proxy admins (standard ProxyAdmin for gateways)
 * - setup L2 AUSD (expects L2_AUSD env var or TODO for deployment)
 * - deploy L1 AUSD gateway
 * - deploy L2 AUSD gateway
 * - init both gateways
 * - if `ROLLUP_OWNER_KEY` is provided, register the gateway in the router through the UpgradeExecutor
 * - if `ROLLUP_OWNER_KEY` is not provided, prepare calldata and store it in `registerAusdGatewayTx.json` file
 * - grant MINTER_ROLE & BURNER_ROLE to L2 AUSD gateway
 * - accept the MINTER_ROLE & BURNER_ROLE from the L2AUSD Gateway
 * 
 */
async function main() {
  console.log('Starting AUSD bridge deployment')

  _checkEnvVars()

  const { deployerL1, deployerL2 } = await _loadWallets()
  console.log('Loaded deployer wallets')

  const inbox = process.env['INBOX'] as string
  await _registerNetworks(deployerL1.provider, deployerL2.provider, inbox)
  console.log('Networks registered in SDK')

  const parentChainId = await deployerL1.getChainId()
  let parentOverrides: Overrides = {}
  if (parentChainId === 42161 || parentChainId === 421614) {
    // Arbitrum One and Sepolia
    parentOverrides = {
      gasLimit: 30_000_000,
    }
  }

  const childGasPrice = await deployerL2.provider.getGasPrice()
  console.log(`Child gas price: ${childGasPrice}`)
  console.log(`Adjusting child maxFeePerGas to ${childGasPrice.mul(3).div(2)}`)
  const childOverrides: Overrides = {
    maxFeePerGas: childGasPrice.mul(3).div(2),
    maxPriorityFeePerGas: 0,
  }

  // Check for already deployed contracts (for resuming failed deployments)
  const existingL1Gateway = process.env['L1_AUSD_GATEWAY']
  const existingL2Gateway = process.env['L2_AUSD_GATEWAY']
  const existingProxyAdminL1 = process.env['PROXY_ADMIN_L1']
  const existingProxyAdminL2 = process.env['PROXY_ADMIN_L2']

  let proxyAdminL1: ProxyAdmin
  let proxyAdminL2: ProxyAdmin
  
  if (existingProxyAdminL1) {
    console.log('Using existing L1 ProxyAdmin: ', existingProxyAdminL1)
    proxyAdminL1 = ProxyAdmin__factory.connect(existingProxyAdminL1, deployerL1)
  } else {
    proxyAdminL1 = await _deployProxyAdmin(deployerL1, parentOverrides)
    console.log('L1 ProxyAdmin deployed: ', proxyAdminL1.address)
  }

  if (existingProxyAdminL2) {
    console.log('Using existing L2 ProxyAdmin: ', existingProxyAdminL2)
    proxyAdminL2 = ProxyAdmin__factory.connect(existingProxyAdminL2, deployerL2)
  } else {
    proxyAdminL2 = await _deployProxyAdmin(deployerL2, childOverrides)
    console.log('L2 ProxyAdmin deployed: ', proxyAdminL2.address)
  }

  // Setup L2 AUSD
  const l2AusdAddress = await _setupL2Ausd(deployerL2, childOverrides)
  console.log('L2 AUSD address: ', l2AusdAddress)

  let l1AusdGateway: L1AUSDGateway | L1OrbitAUSDGateway
  let l2AusdGateway: L2AUSDGateway
  
  const isFeeToken = (await _getFeeToken(inbox, deployerL1.provider)) != ethers.constants.AddressZero

  if (existingL1Gateway) {
    console.log('Using existing L1 AUSD gateway: ', existingL1Gateway)
    l1AusdGateway = isFeeToken
      ? L1OrbitAUSDGateway__factory.connect(existingL1Gateway, deployerL1)
      : L1AUSDGateway__factory.connect(existingL1Gateway, deployerL1)
  } else {
    l1AusdGateway = await _deployL1AusdGateway(
      deployerL1,
      proxyAdminL1,
      inbox,
      parentOverrides
    )
    console.log('L1 AUSD gateway deployed: ', l1AusdGateway.address)
  }

  if (existingL2Gateway) {
    console.log('Using existing L2 AUSD gateway: ', existingL2Gateway)
    l2AusdGateway = L2AUSDGateway__factory.connect(existingL2Gateway, deployerL2)
  } else {
    l2AusdGateway = await _deployL2AusdGateway(deployerL2, proxyAdminL2, childOverrides)
    console.log('L2 AUSD gateway deployed: ', l2AusdGateway.address)
  }
  
  await _initializeGateways(
    l1AusdGateway,
    l2AusdGateway,
    inbox,
    l2AusdAddress,
    deployerL1,
    deployerL2,
    parentOverrides,
    childOverrides
  )
  console.log('AUSD gateways initialized')

  await _registerGateway(
    deployerL1.provider,
    deployerL2.provider,
    inbox,
    l1AusdGateway.address,
    parentOverrides,
    childOverrides,
  )
  if (!process.env['ROLLUP_OWNER_KEY']) {
    console.log(
      'Multisig transaction to register AUSD gateway prepared and stored in',
      REGISTRATION_TX_FILE
    )
  } else {
    console.log('AUSD gateway registered')
  }

  // Grant MINTER_ROLE and BURNER_ROLE to L2 Gateway
  await _addRolesToL2Gateway(l2AusdGateway, l2AusdAddress, deployerL2, childOverrides)
  console.log('MINTER_ROLE and BURNER_ROLE granted to L2 gateway')

  fs.writeFileSync('/Users/dhruvagarwal/Developer/conduit/token-bridge-contracts/scripts/ausd-bridge-deployment/config/ausd.json', JSON.stringify({
    proxyAdminL1: proxyAdminL1.address,
    proxyAdminL2: proxyAdminL2.address,
    l2Ausd: l2AusdAddress,
    l1AusdGateway: l1AusdGateway.address,
    l2AusdGateway: l2AusdGateway.address,
  }))
}

async function _loadWallets(): Promise<{
  deployerL1: Wallet
  deployerL2: Wallet
}> {
  const parentRpc = process.env['PARENT_RPC'] as string
  const parentDeployerKey = process.env['PARENT_DEPLOYER_KEY'] as string
  const childRpc = process.env['CHILD_RPC'] as string
  const childDeployerKey = process.env['CHILD_DEPLOYER_KEY'] as string

  const parentProvider = new JsonRpcProvider(parentRpc)
  const deployerL1 = new ethers.Wallet(parentDeployerKey, parentProvider)

  const childProvider = new JsonRpcProvider(childRpc)
  const deployerL2 = new ethers.Wallet(childDeployerKey, childProvider)

  return { deployerL1, deployerL2 }
}

async function _deployProxyAdmin(deployer: Wallet, overrides?: Overrides): Promise<ProxyAdmin> {
  const proxyAdminFac = await new ProxyAdmin__factory(deployer).deploy(overrides)
  return await proxyAdminFac.deployed()
}

async function _setupL2Ausd(
  deployerL2Wallet: Wallet,
  overrides: Overrides
): Promise<string> {
  const l2AusdEnv = process.env['L2_AUSD']
  if (l2AusdEnv) {
    console.log(`Using existing L2 AUSD at ${l2AusdEnv}`)
    return l2AusdEnv
  }

  // TODO: Implement AUSD deployment if needed.
  // For now, we expect the user to provide the L2 AUSD address.
  // You can use the 'DeployAgoraDollarImplementation.s.sol' logic here if you want to deploy it via this script,
  // but that requires AgoraDollar artifacts which might not be present in this repo.
  
  throw new Error('L2_AUSD env var not set. Please deploy AUSD on L2 and provide the address.')
}

async function _deployL1AusdGateway(
  deployerL1: Wallet,
  proxyAdmin: ProxyAdmin,
  inboxAddress: string,
  overrides: Overrides
): Promise<L1AUSDGateway | L1OrbitAUSDGateway> {
  const isFeeToken =
    (await _getFeeToken(inboxAddress, deployerL1.provider)) !=
    ethers.constants.AddressZero

  const l1AusdGatewayFactory = isFeeToken
    ? await new L1OrbitAUSDGateway__factory(deployerL1).deploy(overrides)
    : await new L1AUSDGateway__factory(deployerL1).deploy(overrides)
  const l1AusdGatewayLogic = await l1AusdGatewayFactory.deployed()
  const tupFactory = await new TransparentUpgradeableProxy__factory(
    deployerL1
  ).deploy(l1AusdGatewayLogic.address, proxyAdmin.address, '0x', overrides)
  const tup = await tupFactory.deployed()
  return isFeeToken
    ? L1OrbitAUSDGateway__factory.connect(tup.address, deployerL1)
    : L1AUSDGateway__factory.connect(tup.address, deployerL1)
}

async function _deployL2AusdGateway(
  deployerL2: Wallet,
  proxyAdmin: ProxyAdmin,
  overrides: Overrides,
): Promise<L2AUSDGateway> {
  const l2AusdGatewayFactory = await new L2AUSDGateway__factory(
    deployerL2
  ).deploy(overrides)
  const l2AusdGatewayLogic = await l2AusdGatewayFactory.deployed()
  const tupFactory = await new TransparentUpgradeableProxy__factory(
    deployerL2
  ).deploy(l2AusdGatewayLogic.address, proxyAdmin.address, '0x', overrides)
  const tup = await tupFactory.deployed()
  return L2AUSDGateway__factory.connect(tup.address, deployerL2)
}

/**
 * Initialize gateways
 */
async function _initializeGateways(
  l1AusdGateway: L1AUSDGateway | L1OrbitAUSDGateway,
  l2AusdGateway: L2AUSDGateway,
  inbox: string,
  l2Ausd: string,
  deployerL1: Wallet,
  deployerL2: Wallet,
  overridesL1: Overrides,
  overridesL2: Overrides
) {
  const l1Router = process.env['L1_ROUTER'] as string
  const l2Router = process.env['L2_ROUTER'] as string
  const l1Ausd = process.env['L1_AUSD'] as string

  /// initialize L1 gateway
  const _l2CounterPart = l2AusdGateway.address
  const _owner = deployerL1.address

  await (
    await l1AusdGateway
      .connect(deployerL1)
      .initialize(_l2CounterPart, l1Router, inbox, l1Ausd, l2Ausd, _owner, { ...overridesL1 })
  ).wait()

  /// initialize L2 gateway
  const _l1Counterpart = l1AusdGateway.address
  const ownerL2 = deployerL2.address
  await (
    await l2AusdGateway.initialize(
      _l1Counterpart,
      l2Router,
      l1Ausd,
      l2Ausd,
      ownerL2,
      { ...overridesL2 }
    )
  ).wait()

  ///// verify initialization
  if (
    (await l1AusdGateway.router()).toLowerCase() != l1Router.toLowerCase() ||
    (await l1AusdGateway.inbox()).toLowerCase() != inbox.toLowerCase() ||
    (await l1AusdGateway.l1AUSD()).toLowerCase() != l1Ausd.toLowerCase() ||
    (await l1AusdGateway.l2AUSD()).toLowerCase() != l2Ausd.toLowerCase() ||
    (await l1AusdGateway.owner()).toLowerCase() != _owner.toLowerCase() ||
    (await l1AusdGateway.counterpartGateway()).toLowerCase() != _l2CounterPart.toLowerCase()
  ) {
    throw new Error('L1 gateway initialization failed')
  }

  if (
    (await l2AusdGateway.counterpartGateway()).toLowerCase() != _l1Counterpart.toLowerCase() ||
    (await l2AusdGateway.router()).toLowerCase() != l2Router.toLowerCase() ||
    (await l2AusdGateway.l1AUSD()).toLowerCase() != l1Ausd.toLowerCase() ||
    (await l2AusdGateway.l2AUSD()).toLowerCase() != l2Ausd.toLowerCase() ||
    (await l2AusdGateway.owner()).toLowerCase() != ownerL2.toLowerCase()
  ) {
    throw new Error('L2 gateway initialization failed')
  }
}

/**
 * Do the gateway registration if rollup owner key is provided.
 * Otherwise prepare the TX payload and store it in a file.
 */
async function _registerGateway(
  parentProvider: Provider,
  childProvider: Provider,
  inbox: string,
  l1AusdGatewayAddress: string,
  parentOverrides: Overrides,
  childOverrides: Overrides
) {
  const isFeeToken =
    (await _getFeeToken(inbox, parentProvider)) != ethers.constants.AddressZero

  const l1RouterAddress = process.env['L1_ROUTER'] as string
  const l2RouterAddress = process.env['L2_ROUTER'] as string
  const l1AusdAddress = process.env['L1_AUSD'] as string

  const l1Router = isFeeToken
    ? L1OrbitGatewayRouter__factory.connect(l1RouterAddress, parentProvider)
    : L1GatewayRouter__factory.connect(l1RouterAddress, parentProvider)

  /// load upgrade executor
  const routerOwnerAddress = await l1Router.owner()
  if (!(await _isUpgradeExecutor(routerOwnerAddress, parentProvider))) {
    throw new Error(`Router owner ${routerOwnerAddress} is not an UpgradeExecutor`)
  }
  const upgradeExecutor = UpgradeExecutor__factory.connect(
    routerOwnerAddress,
    parentProvider
  )

  /// prepare calldata for executor
  const routerRegistrationData =
    L2GatewayRouter__factory.createInterface().encodeFunctionData(
      'setGateway',
      [[l1AusdAddress], [l1AusdGatewayAddress]]
    )

  const l1ToL2MessageGasEstimate = new L1ToL2MessageGasEstimator(childProvider)
  const retryableParams = await l1ToL2MessageGasEstimate.estimateAll(
    {
      from: l1RouterAddress,
      to: l2RouterAddress,
      l2CallValue: BigNumber.from(0),
      excessFeeRefundAddress: ethers.Wallet.createRandom().address,
      callValueRefundAddress: ethers.Wallet.createRandom().address,
      data: routerRegistrationData,
    },
    await getBaseFee(parentProvider),
    parentProvider
  )

  const maxGas = retryableParams.gasLimit
  const gasPriceBid = retryableParams.maxFeePerGas.mul(3)
  let maxSubmissionCost = retryableParams.maxSubmissionCost
  let totalFee = maxGas.mul(gasPriceBid).add(maxSubmissionCost)
  if (isFeeToken) {
    totalFee = await _getPrescaledAmount(
      await _getFeeToken(inbox, parentProvider),
      parentProvider,
      totalFee
    )
  }

  const registrationCalldata = isFeeToken
    ? L1OrbitGatewayRouter__factory.createInterface().encodeFunctionData(
        'setGateways(address[],address[],uint256,uint256,uint256,uint256)',
        [
          [l1AusdAddress],
          [l1AusdGatewayAddress],
          maxGas,
          gasPriceBid,
          maxSubmissionCost,
          totalFee,
        ]
      )
    : L1GatewayRouter__factory.createInterface().encodeFunctionData(
        'setGateways(address[],address[],uint256,uint256,uint256)',
        [
          [l1AusdAddress],
          [l1AusdGatewayAddress],
          maxGas,
          gasPriceBid,
          maxSubmissionCost,
        ]
      )

  if (!process.env['ROLLUP_OWNER_KEY']) {
    // prepare multisig transaction(s)
    const txs = []
    if (isFeeToken) {
      // prepare TX to transfer fee amount to upgrade executor
      const feeTokenContract = IERC20__factory.connect(
        await _getFeeToken(inbox, parentProvider),
        parentProvider
      )
      const feeTransferData = feeTokenContract.interface.encodeFunctionData(
        'transfer',
        [upgradeExecutor.address, totalFee]
      )
      txs.push({
        to: feeTokenContract.address,
        value: BigNumber.from(0).toString(),
        data: feeTransferData,
      })

      // prepare TX to approve router to spend the fee token
      const approveData = upgradeExecutor.interface.encodeFunctionData(
        'executeCall',
        [
          feeTokenContract.address,
          feeTokenContract.interface.encodeFunctionData('approve', [
            l1RouterAddress,
            totalFee,
          ]),
        ]
      )

      txs.push({
        to: upgradeExecutor.address,
        value: BigNumber.from(0).toString(),
        data: approveData,
      })
    }

    const upgExecutorData = upgradeExecutor.interface.encodeFunctionData(
      'executeCall',
      [l1Router.address, registrationCalldata]
    )
    const to = upgradeExecutor.address

    // store the multisig transaction to file
    txs.push({
      to,
      value: isFeeToken ? BigNumber.from(0).toString() : totalFee.toString(),
      data: upgExecutorData,
    })
    fs.writeFileSync(REGISTRATION_TX_FILE, JSON.stringify(txs))
  } else {
    // load rollup owner (account with executor rights on the upgrade executor)
    const rollupOwnerKey = process.env['ROLLUP_OWNER_KEY'] as string
    const rollupOwner = new ethers.Wallet(rollupOwnerKey, parentProvider)

    if (isFeeToken) {
      // transfer the fee amount to upgrade executor
      const feeToken = await _getFeeToken(inbox, parentProvider)
      const feeTokenContract = IERC20__factory.connect(feeToken, rollupOwner)
      await (
        await feeTokenContract
          .connect(rollupOwner)
          .transfer(upgradeExecutor.address, totalFee, parentOverrides)
      ).wait()

      // approve router to spend the fee token
      await (
        await upgradeExecutor
          .connect(rollupOwner)
          .executeCall(
            feeToken,
            feeTokenContract.interface.encodeFunctionData('approve', [
              l1RouterAddress,
              totalFee,
            ]),
            parentOverrides
          )
      ).wait()
    }

    // execute the registration
    const gwRegistrationTx = await upgradeExecutor
      .connect(rollupOwner)
      .executeCall(l1Router.address, registrationCalldata, {
        ...parentOverrides,
        value: isFeeToken ? BigNumber.from(0) : totalFee,
      })
    await _waitOnL2Msg(gwRegistrationTx, childProvider)
    fs.writeFileSync(REGISTRATION_TX_FILE, gwRegistrationTx.hash)
  }
}

/**
 * Grant MINTER_ROLE and BURNER_ROLE to L2 gateway on L2 AUSD contract.
 * AUSD uses a two-step role transfer: transferRole() then acceptTransferRole()
 */
async function _addRolesToL2Gateway(
  l2AusdGateway: L2AUSDGateway,
  l2AusdAddress: string,
  deployerL2: Wallet,
  overrides: Overrides
) {
  // Minimal ABI for AUSD role transfer
  const abi = [
    'function transferRole(bytes32 role, address newAddress) external',
    'function MINTER_ROLE() external view returns (bytes32)',
    'function BURNER_ROLE() external view returns (bytes32)'
  ]
  const l2Ausd = new ethers.Contract(l2AusdAddress, abi, deployerL2)

  const MINTER_ROLE = await l2Ausd.MINTER_ROLE()
  const BURNER_ROLE = await l2Ausd.BURNER_ROLE()
  
  // Transfer MINTER_ROLE
  console.log(`Transferring MINTER_ROLE (${MINTER_ROLE}) to ${l2AusdGateway.address}`)
  await (
    await l2Ausd.transferRole(MINTER_ROLE, l2AusdGateway.address, overrides)
  ).wait()
  console.log(`Gateway accepting MINTER_ROLE...`)
  await (
    await l2AusdGateway.acceptAUSDRole(MINTER_ROLE, overrides)
  ).wait()

  // Transfer BURNER_ROLE
  console.log(`Transferring BURNER_ROLE (${BURNER_ROLE}) to ${l2AusdGateway.address}`)
  await (
    await l2Ausd.transferRole(BURNER_ROLE, l2AusdGateway.address, overrides)
  ).wait()
  console.log(`Gateway accepting BURNER_ROLE...`)
  await (
    await l2AusdGateway.acceptAUSDRole(BURNER_ROLE, overrides)
  ).wait()
}

/**
 * Wait for L1->L2 message to be redeemed
 */
async function _waitOnL2Msg(tx: ContractTransaction, childProvider: Provider) {
  const receipt = await tx.wait()
  const l1TxReceipt = new L1TransactionReceipt(receipt)
  const messages = await l1TxReceipt.getL1ToL2Messages(childProvider)
  const status = await messages[0].waitForStatus()
  if (status.status !== L1ToL2MessageStatus.REDEEMED) {
    throw new Error(`L1ToL2 message not redeemed: ${JSON.stringify(status)}`)
  }
}

/**
 * Check if owner is UpgardeExecutor by polling ADMIN_ROLE() and EXECUTOR_ROLE()
 */
async function _isUpgradeExecutor(
  routerOwnerAddress: string,
  provider: Provider
): Promise<boolean> {
  const upgExecutor = UpgradeExecutor__factory.connect(
    routerOwnerAddress,
    provider
  )
  try {
    await upgExecutor.ADMIN_ROLE()
    await upgExecutor.EXECUTOR_ROLE()
    return true
  } catch (e) {
    return false
  }
}

/**
 * Register L1 and L2 networks in the SDK
 */
async function _registerNetworks(
  l1Provider: Provider,
  l2Provider: Provider,
  inboxAddress: string
): Promise<{
  l1Network: L1Network
  l2Network: Omit<L2Network, 'tokenBridge'>
}> {
  const l1NetworkInfo = await l1Provider.getNetwork()
  const l2NetworkInfo = await l2Provider.getNetwork()

  const l1Network: L1Network = {
    blockTime: 10,
    chainID: l1NetworkInfo.chainId,
    explorerUrl: '',
    isCustom: true,
    name: l1NetworkInfo.name,
    partnerChainIDs: [l2NetworkInfo.chainId],
    isArbitrum: false,
  }

  const bridge = await IInboxBase__factory.connect(inboxAddress, l1Provider).bridge()
  const rollupAddress = await IBridge__factory.connect(bridge, l1Provider).rollup()
  const rollup = RollupAdminLogic__factory.connect(rollupAddress, l1Provider)
  const l2Network: L2Network = {
    blockTime: 10,
    partnerChainIDs: [],
    chainID: l2NetworkInfo.chainId,
    confirmPeriodBlocks: (await rollup.confirmPeriodBlocks()).toNumber(),
    ethBridge: {
      bridge: await rollup.bridge(),
      inbox: await rollup.inbox(),
      outbox: await rollup.outbox(),
      rollup: rollup.address,
      sequencerInbox: await rollup.sequencerInbox(),
    },
    explorerUrl: '',
    isArbitrum: true,
    isCustom: true,
    name: 'OrbitChain',
    partnerChainID: l1NetworkInfo.chainId,
    retryableLifetimeSeconds: 7 * 24 * 60 * 60,
    nitroGenesisBlock: 0,
    nitroGenesisL1Block: 0,
    depositTimeout: 900000,
    tokenBridge: {
      l1CustomGateway: '',
      l1ERC20Gateway: '',
      l1GatewayRouter: '',
      l1MultiCall: '',
      l1ProxyAdmin: '',
      l1Weth: '',
      l1WethGateway: '',
      l2CustomGateway: '',
      l2ERC20Gateway: '',
      l2GatewayRouter: '',
      l2Multicall: '',
      l2ProxyAdmin: '',
      l2Weth: '',
      l2WethGateway: '',
    },
  }

  // register - needed for retryables
  addCustomNetwork({
    ...(l1Network.chainID === 8453 || l1Network.chainID === 84532 ? { customL1Network: l1Network } : {}),
    customL2Network: l2Network,
  })

  return { l1Network, l2Network }
}

/**
 * Fetch fee token if it exists or return zero address
 */
async function _getFeeToken(
  inbox: string,
  provider: Provider
): Promise<string> {
  const bridge = await IInboxBase__factory.connect(inbox, provider).bridge()

  let feeToken = ethers.constants.AddressZero

  try {
    feeToken = await IERC20Bridge__factory.connect(bridge, provider).nativeToken()
  } catch {
    // ignore
  }

  return feeToken
}

/**
 * Check if all required env vars are set
 */
function _checkEnvVars() {
  const required = [
    'PARENT_RPC',
    'PARENT_DEPLOYER_KEY',
    'CHILD_RPC',
    'CHILD_DEPLOYER_KEY',
    'INBOX',
    'L1_ROUTER',
    'L2_ROUTER',
    'L1_AUSD',
    // 'L2_AUSD' is optional if we were deploying it, but here we require it or throw
  ]
  for (const v of required) {
    if (!process.env[v]) {
      throw new Error(`Missing env var ${v}`)
    }
  }
  
  // Validate address format (must have 0x prefix)
  const addressVars = ['INBOX', 'L1_ROUTER', 'L2_ROUTER', 'L1_AUSD', 'L2_AUSD', 'L1_AUSD_GATEWAY', 'L2_AUSD_GATEWAY', 'PROXY_ADMIN_L1', 'PROXY_ADMIN_L2']
  for (const v of addressVars) {
    const value = process.env[v]
    if (value && !value.startsWith('0x')) {
      throw new Error(`Invalid address format for ${v}: "${value}". Address must start with 0x`)
    }
  }
}

async function _getPrescaledAmount(
  nativeTokenAddress: string,
  provider: Provider,
  amount: BigNumber
): Promise<BigNumber> {
  const nativeToken = ERC20__factory.connect(nativeTokenAddress, provider)
  const decimals = BigNumber.from(await nativeToken.decimals())
  if (decimals.lt(BigNumber.from(18))) {
    const scalingFactor = BigNumber.from(10).pow(
      BigNumber.from(18).sub(decimals)
    )
    let prescaledAmount = amount.div(scalingFactor)
    // round up if needed
    if (prescaledAmount.mul(scalingFactor).lt(amount)) {
      prescaledAmount = prescaledAmount.add(BigNumber.from(1))
    }
    return prescaledAmount
  } else if (decimals.gt(BigNumber.from(18))) {
    return amount.mul(BigNumber.from(10).pow(decimals.sub(BigNumber.from(18))))
  }
  return amount
}
