import { BigNumber, Contract, ContractTransaction, Signer, Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { makeSigner } from '../kms/GcpKmsSigner'

// Signer extended with a pre-fetched address property so sync `.address`
// accesses work for both ethers.Wallet and GcpKmsSigner.
type SignerWithAddress = Signer & { address: string }

async function toSignerWithAddress(signer: Signer): Promise<SignerWithAddress> {
  const address = await signer.getAddress()
  // Object.assign can't overwrite ethers.Wallet.address (readonly getter).
  // Use Object.create so address is an own property on the wrapper while
  // all signer methods remain accessible via prototype chain.
  const wrapped = Object.create(signer) as SignerWithAddress
  Object.defineProperty(wrapped, 'address', { value: address, enumerable: true, configurable: true })
  return wrapped
}
import {
  ERC20__factory,
  IBridge__factory,
  IERC20__factory,
  IERC20Bridge__factory,
  IFiatToken__factory,
  IFiatTokenProxy__factory,
  IInboxBase__factory,
  L1GatewayRouter__factory,
  L1OrbitGatewayRouter__factory,
  L1OrbitUSDCGateway,
  L1OrbitUSDCGateway__factory,
  L1USDCGateway,
  L1USDCGateway__factory,
  L2GatewayRouter__factory,
  L2USDCGateway,
  L2USDCGateway__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
  UpgradeExecutor__factory,
} from '../../build/types'
import { JsonRpcProvider, Provider } from '@ethersproject/providers'
import dotenv from 'dotenv'
import {
  abi as SigCheckerAbi,
  bytecode as SigCheckerBytecode,
} from '@offchainlabs/stablecoin-evm/artifacts/hardhat/contracts/util/SignatureChecker.sol/SignatureChecker.json'
import {
  abi as UsdcAbi,
  bytecode as UsdcBytecode,
} from '@offchainlabs/stablecoin-evm/artifacts/hardhat/contracts/v2/FiatTokenV2_2.sol/FiatTokenV2_2.json'
import {
  abi as UsdcProxyAbi,
  bytecode as UsdcProxyBytecode,
} from '@offchainlabs/stablecoin-evm/artifacts/hardhat/contracts/v1/FiatTokenProxy.sol/FiatTokenProxy.json'
import {
  abi as MasterMinterAbi,
  bytecode as MasterMinterBytecode,
} from '@offchainlabs/stablecoin-evm/artifacts/hardhat/contracts/minting/MasterMinter.sol/MasterMinter.json'
import {
  addCustomNetwork,
  L1Network,
  L1ToL2MessageGasEstimator,
  L1ToL2MessageStatus,
  L1TransactionReceipt,
  L2Network,
} from '@arbitrum/sdk'
import { RollupAdminLogic__factory } from '@arbitrum/sdk/dist/lib/abi/factories/RollupAdminLogic__factory'
import { getBaseFee } from '@arbitrum/sdk/dist/lib/utils/lib'
import { Overrides } from '@ethersproject/contracts'
import fs from 'fs'

dotenv.config()

// ethers v5 hardcodes maxPriorityFeePerGas to 1.5 gwei in getFeeData(), which massively
// overpays on Orbit L2s where the actual priority fee is 0.
function patchFeeData(provider: JsonRpcProvider): JsonRpcProvider {
  provider.getFeeData = async () => {
    const [block, gasPrice] = await Promise.all([
      provider.getBlock('latest'),
      provider.getGasPrice(),
    ])
    let maxPriorityFeePerGas = BigNumber.from(0)
    try {
      maxPriorityFeePerGas = BigNumber.from(await provider.send('eth_maxPriorityFeePerGas', []))
    } catch {
      // RPC doesn't support eth_maxPriorityFeePerGas — 0 is fine for most L2s
    }
    const baseFee = block.baseFeePerGas ?? BigNumber.from(0)
    const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas)
    return { gasPrice, maxFeePerGas, maxPriorityFeePerGas, lastBaseFeePerGas: baseFee }
  }
  return provider
}

const REGISTRATION_TX_FILE = '/config/registerUsdcGatewayTx.json'
const EXISTING_ADDRESSES_FILE = '/existing/usdc.json'

type Addresses = {
  proxyAdminL1: string
  proxyAdminL2: string
  l2Usdc: string
  masterMinter: string
  l1UsdcGateway: string
  l2UsdcGateway: string
  sigCheckerLib: string
  l2UsdcLogic: string
}

const ADDRESS_FIELDS = [
  'proxyAdminL1',
  'proxyAdminL2',
  'l2Usdc',
  'masterMinter',
  'l1UsdcGateway',
  'l2UsdcGateway',
  'sigCheckerLib',
  'l2UsdcLogic',
] as const

function _loadExistingAddresses(): Addresses | undefined {
  if (!fs.existsSync(EXISTING_ADDRESSES_FILE)) return undefined
  let parsed: Partial<Addresses>
  try {
    parsed = JSON.parse(fs.readFileSync(EXISTING_ADDRESSES_FILE, 'utf-8'))
  } catch (e) {
    console.log(
      `Failed to parse ${EXISTING_ADDRESSES_FILE}, treating as fresh deploy:`,
      e
    )
    return undefined
  }
  const complete = ADDRESS_FIELDS.every(
    (f) =>
      typeof parsed[f] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(parsed[f]!)
  )
  if (!complete) {
    console.log(
      `Existing address state at ${EXISTING_ADDRESSES_FILE} is missing fields or malformed, treating as fresh deploy`
    )
    return undefined
  }
  return parsed as Addresses
}

main().then(() => console.log('Done.'))

/**
 * USDC bridge deployment script. Script will do the following:
 * - load deployer wallets for L1 and L2
 * - register L1 and L2 networks in SDK
 * - deploy new L1 and L2 proxy admins
 * - deploy bridged (L2) USDC using the Circle's implementation
 * - init L2 USDC
 * - deploy L1 USDC gateway
 * - deploy L2 USDC gateway
 * - init both gateways
 * - if `ROLLUP_OWNER_KEY` is provided, register the gateway in the router through the UpgradeExecutor
 * - if `ROLLUP_OWNER_KEY` is not provided, prepare calldata and store it in `registerUsdcGatewayTx.json` file
 * - set minter role to L2 USDC gateway with max allowance
 */
async function main() {
  console.log('Starting USDC bridge deployment')

  _checkEnvVars()

  const { deployerL1, deployerL2 } = await _loadWallets()
  console.log('Loaded deployer wallets')

  const inbox = process.env['INBOX'] as string
  await _registerNetworks(deployerL1.provider!, deployerL2.provider!, inbox)
  console.log('Networks registered in SDK')

  const parentChainId = await deployerL1.getChainId()
  let parentOverrides: Overrides = {}
  if (parentChainId === 42161 || parentChainId === 421614) {
    const parentGasPrice = await deployerL1.provider!.getGasPrice()
    console.log(`Parent gas price: ${parentGasPrice}`)
    console.log(`Adjusting parent maxFeePerGas to ${parentGasPrice.mul(3).div(2)}`)
    parentOverrides = {
      maxFeePerGas: parentGasPrice.mul(3).div(2), // allows baseFee to increase by 50%
      maxPriorityFeePerGas: 0,
    }
  }
  const childGasPrice = await deployerL2.provider!.getGasPrice()
  console.log(`Child gas price: ${childGasPrice}`)
  console.log(`Adjusting child maxFeePerGas to ${childGasPrice.mul(3).div(2)}`)
  const childOverrides: Overrides = {
    maxFeePerGas: childGasPrice.mul(3).div(2), // allows baseFee to increase by 50%
    maxPriorityFeePerGas: 0,
  }

  // If a previous deploy run already produced addresses, reuse them. The chart
  // mounts the `addresses` ConfigMap at /existing/usdc.json (optional). On
  // retry this lets us skip the contract deploys and gateway init, which are
  // one-shot (initialize() reverts on a second call) and would otherwise leave
  // the first run's contracts orphaned.
  const existing = _loadExistingAddresses()
  let addresses: Addresses

  if (existing) {
    console.log(
      'Reusing existing deployment state, skipping contract deploys and gateway init'
    )
    addresses = existing
  } else {
    const proxyAdminL1 = await _deployProxyAdmin(deployerL1, parentOverrides)
    console.log('L1 ProxyAdmin deployed: ', proxyAdminL1.address)

    const proxyAdminL2 = await _deployProxyAdmin(deployerL2, childOverrides)
    console.log('L2 ProxyAdmin deployed: ', proxyAdminL2.address)

    const { l2Usdc, l2UsdcLogic, masterMinter, sigCheckerLib } =
      await _deployBridgedUsdc(deployerL2, proxyAdminL2, childOverrides)
    console.log('Bridged (L2) USDC deployed: ', l2Usdc.address)

    const l1UsdcGateway = await _deployL1UsdcGateway(
      deployerL1,
      proxyAdminL1,
      inbox,
      parentOverrides
    )
    console.log('L1 USDC gateway deployed: ', l1UsdcGateway.address)

    const l2UsdcGateway = await _deployL2UsdcGateway(
      deployerL2,
      proxyAdminL2,
      childOverrides
    )
    console.log('L2 USDC gateway deployed: ', l2UsdcGateway.address)

    await _initializeGateways(
      l1UsdcGateway,
      l2UsdcGateway,
      inbox,
      l2Usdc.address,
      deployerL1,
      deployerL2,
      parentOverrides,
      childOverrides
    )
    console.log('Usdc gateways initialized')

    await _addMinterRoleToL2Gateway(
      l2UsdcGateway,
      deployerL2,
      masterMinter,
      childOverrides
    )
    console.log('Minter role with max allowance added to L2 gateway')

    addresses = {
      proxyAdminL1: proxyAdminL1.address,
      proxyAdminL2: proxyAdminL2.address,
      l2Usdc: l2Usdc.address,
      masterMinter: masterMinter.address,
      l1UsdcGateway: l1UsdcGateway.address,
      l2UsdcGateway: l2UsdcGateway.address,
      sigCheckerLib: sigCheckerLib.address,
      l2UsdcLogic: l2UsdcLogic.address,
    }
  }

  // Always (re)generate the multisig tx payload with fresh fee params. Safe to
  // run every invocation: in the default path it just writes the JSON file; in
  // the ROLLUP_OWNER_KEY path it re-executes setGateway (idempotent on the
  // router, same mapping).
  await _registerGateway(
    deployerL1.provider!,
    deployerL2.provider!,
    inbox,
    addresses.l1UsdcGateway,
    parentOverrides,
    childOverrides
  )
  if (!process.env['ROLLUP_OWNER_KEY']) {
    console.log(
      'Multisig transaction to register USDC gateway prepared and stored in',
      REGISTRATION_TX_FILE
    )
  } else {
    console.log('Usdc gateway registered')
  }

  // Always write /config/usdc.json so the chart's write-addresses-cm init
  // container can persist the ConfigMap on both fresh and reused runs.
  fs.writeFileSync('/config/usdc.json', JSON.stringify(addresses))
}

async function _loadWallets(): Promise<{
  deployerL1: SignerWithAddress
  deployerL2: SignerWithAddress
}> {
  const parentRpc = process.env['PARENT_RPC'] as string
  const parentDeployerKey = process.env['PARENT_DEPLOYER_KEY']
  const parentDeployerKmsKey = process.env['PARENT_DEPLOYER_KMS_KEY']
  const childRpc = process.env['CHILD_RPC'] as string
  const childDeployerKey = process.env['CHILD_DEPLOYER_KEY']
  const childDeployerKmsKey = process.env['CHILD_DEPLOYER_KMS_KEY']

  const parentProvider = patchFeeData(new JsonRpcProvider(parentRpc))
  const deployerL1 = await toSignerWithAddress(
    makeSigner(parentDeployerKmsKey, parentDeployerKey, parentProvider)
  )

  const childProvider = patchFeeData(new JsonRpcProvider(childRpc))
  const deployerL2 = await toSignerWithAddress(
    makeSigner(childDeployerKmsKey, childDeployerKey, childProvider)
  )

  return { deployerL1, deployerL2 }
}

async function _deployProxyAdmin(deployer: SignerWithAddress, overrides?: Overrides): Promise<ProxyAdmin> {
  const proxyAdminFac = await new ProxyAdmin__factory(deployer).deploy(overrides)
  return await proxyAdminFac.deployed()
}

async function _deployBridgedUsdc(
  deployerL2Wallet: SignerWithAddress,
  proxyAdminL2: ProxyAdmin,
  overrides: Overrides
) {
  /// create l2 usdc behind proxy
  const { l2UsdcLogic, sigCheckerLib } = await _deployUsdcLogic(deployerL2Wallet, overrides)
  const l2UsdcProxyAddress = await _deployUsdcProxy(
    deployerL2Wallet,
    l2UsdcLogic.address,
    proxyAdminL2.address,
    overrides
  )

  /// deploy master minter
  const masterMinterL2Fac = new ethers.ContractFactory(
    MasterMinterAbi,
    MasterMinterBytecode,
    deployerL2Wallet
  )
  const masterMinter = await masterMinterL2Fac.deploy(l2UsdcProxyAddress, overrides)
  await masterMinter.deployed()

  /// init usdc proxy
  const l2UsdcFiatToken = IFiatToken__factory.connect(
    l2UsdcProxyAddress,
    deployerL2Wallet
  )

  const pauserL2 = deployerL2Wallet
  const blacklisterL2 = deployerL2Wallet
  const lostAndFound = deployerL2Wallet
  await (
    await l2UsdcFiatToken.initialize(
      'Bridged USDC',
      'USDC.e',
      'USD',
      6,
      masterMinter.address,
      pauserL2.address,
      blacklisterL2.address,
      deployerL2Wallet.address,
      overrides
    )
  ).wait()
  await (await l2UsdcFiatToken.initializeV2('Bridged USDC', overrides)).wait()
  await (await l2UsdcFiatToken.initializeV2_1(lostAndFound.address, overrides)).wait()
  await (await l2UsdcFiatToken.initializeV2_2([], 'USDC.e', overrides)).wait()

  /// verify initialization
  if (
    (await l2UsdcFiatToken.name()) != 'Bridged USDC' ||
    (await l2UsdcFiatToken.symbol()) != 'USDC.e' ||
    (await l2UsdcFiatToken.currency()) != 'USD' ||
    (await l2UsdcFiatToken.decimals()) != 6 ||
    (await l2UsdcFiatToken.masterMinter()) != masterMinter.address ||
    (await l2UsdcFiatToken.pauser()) != pauserL2.address ||
    (await l2UsdcFiatToken.blacklister()) != blacklisterL2.address ||
    (await l2UsdcFiatToken.owner()) != deployerL2Wallet.address
  ) {
    throw new Error(
      'Bridged USDC initialization was not successful, might have been frontrun'
    )
  }

  /// init usdc logic to dummy values
  const l2UsdcLogicInit = IFiatToken__factory.connect(
    l2UsdcLogic.address,
    deployerL2Wallet
  )
  const DEAD = '0x000000000000000000000000000000000000dEaD'
  await (
    await l2UsdcLogicInit.initialize('', '', '', 0, DEAD, DEAD, DEAD, DEAD, overrides)
  ).wait()
  await (await l2UsdcLogicInit.initializeV2('', overrides)).wait()
  await (await l2UsdcLogicInit.initializeV2_1(DEAD, overrides)).wait()
  await (await l2UsdcLogicInit.initializeV2_2([], '', overrides)).wait()

  /// verify logic initialization
  if (
    (await l2UsdcLogicInit.name()) != '' ||
    (await l2UsdcLogicInit.symbol()) != '' ||
    (await l2UsdcLogicInit.currency()) != '' ||
    (await l2UsdcLogicInit.decimals()) != 0 ||
    (await l2UsdcLogicInit.masterMinter()) != DEAD ||
    (await l2UsdcLogicInit.pauser()) != DEAD ||
    (await l2UsdcLogicInit.blacklister()) != DEAD ||
    (await l2UsdcLogicInit.owner()) != DEAD
  ) {
    throw new Error('Bridged USDC logic initialization was not successful')
  }

  const l2Usdc = IERC20__factory.connect(
    l2UsdcFiatToken.address,
    deployerL2Wallet
  )

  return { l2Usdc, l2UsdcLogic, masterMinter, sigCheckerLib }
}

async function _deployUsdcLogic(deployer: SignerWithAddress, overrides: Overrides) {
  /// deploy sig checker library
  const sigCheckerFac = new ethers.ContractFactory(
    SigCheckerAbi,
    SigCheckerBytecode,
    deployer
  )
  const sigCheckerLib = await sigCheckerFac.deploy(overrides)
  await sigCheckerLib.deployed()

  // link library to usdc bytecode
  const bytecodeWithPlaceholder: string = UsdcBytecode
  const placeholder = '__$715109b5d747ea58b675c6ea3f0dba8c60$__'

  const libAddressStripped = sigCheckerLib.address.replace(/^0x/, '')
  const bridgedUsdcLogicBytecode = bytecodeWithPlaceholder
    .split(placeholder)
    .join(libAddressStripped)

  // deploy bridged usdc logic
  const bridgedUsdcLogicFactory = new ethers.ContractFactory(
    UsdcAbi,
    bridgedUsdcLogicBytecode,
    deployer
  )
  const bridgedUsdcLogic = await bridgedUsdcLogicFactory.deploy(overrides)
  await bridgedUsdcLogic.deployed()

  return { l2UsdcLogic: bridgedUsdcLogic, sigCheckerLib }
}

async function _deployUsdcProxy(
  deployer: SignerWithAddress,
  bridgedUsdcLogic: string,
  proxyAdmin: string,
  overrides: Overrides
) {
  /// deploy circle's proxy used for usdc
  const usdcProxyFactory = new ethers.ContractFactory(
    UsdcProxyAbi,
    UsdcProxyBytecode,
    deployer
  )
  const usdcProxy = await usdcProxyFactory.deploy(bridgedUsdcLogic, overrides)
  await usdcProxy.deployed()

  /// set proxy admin
  await (
    await IFiatTokenProxy__factory.connect(
      usdcProxy.address,
      deployer
    ).changeAdmin(proxyAdmin, overrides)
  ).wait()

  return usdcProxy.address
}

async function _deployL1UsdcGateway(
  deployerL1: SignerWithAddress,
  proxyAdmin: ProxyAdmin,
  inboxAddress: string,
  overrides: Overrides
): Promise<L1USDCGateway | L1OrbitUSDCGateway> {
  const isFeeToken =
    (await _getFeeToken(inboxAddress, deployerL1.provider!)) !=
    ethers.constants.AddressZero

  const l1UsdcGatewayFactory = isFeeToken
    ? await new L1OrbitUSDCGateway__factory(deployerL1).deploy(overrides)
    : await new L1USDCGateway__factory(deployerL1).deploy(overrides)
  const l1UsdcGatewayLogic = await l1UsdcGatewayFactory.deployed()
  const tupFactory = await new TransparentUpgradeableProxy__factory(
    deployerL1
  ).deploy(l1UsdcGatewayLogic.address, proxyAdmin.address, '0x', overrides)
  const tup = await tupFactory.deployed()
  return isFeeToken
    ? L1OrbitUSDCGateway__factory.connect(tup.address, deployerL1)
    : L1USDCGateway__factory.connect(tup.address, deployerL1)
}

async function _deployL2UsdcGateway(
  deployerL2: SignerWithAddress,
  proxyAdmin: ProxyAdmin,
  overrides: Overrides,
): Promise<L2USDCGateway> {
  const l2USDCCustomGatewayFactory = await new L2USDCGateway__factory(
    deployerL2
  ).deploy(overrides)
  const l2USDCCustomGatewayLogic = await l2USDCCustomGatewayFactory.deployed()
  const tupFactory = await new TransparentUpgradeableProxy__factory(
    deployerL2
  ).deploy(l2USDCCustomGatewayLogic.address, proxyAdmin.address, '0x', overrides)
  const tup = await tupFactory.deployed()
  return L2USDCGateway__factory.connect(tup.address, deployerL2)
}

/**
 * Initialize gateways
 */
async function _initializeGateways(
  l1UsdcGateway: L1USDCGateway | L1OrbitUSDCGateway,
  l2UsdcGateway: L2USDCGateway,
  inbox: string,
  l2Usdc: string,
  deployerL1: SignerWithAddress,
  deployerL2: SignerWithAddress,
  overridesL1: Overrides,
  overridesL2: Overrides
) {
  const l1Router = process.env['L1_ROUTER'] as string
  const l2Router = process.env['L2_ROUTER'] as string
  const l1Usdc = process.env['L1_USDC'] as string

  /// initialize L1 gateway
  const _l2CounterPart = l2UsdcGateway.address
  const _owner = deployerL1.address

  await (
    await l1UsdcGateway
      .connect(deployerL1)
      .initialize(_l2CounterPart, l1Router, inbox, l1Usdc, l2Usdc, _owner, overridesL1)
  ).wait()

  /// initialize L2 gateway
  const _l1Counterpart = l1UsdcGateway.address
  const ownerL2 = deployerL2.address
  await (
    await l2UsdcGateway.initialize(
      _l1Counterpart,
      l2Router,
      l1Usdc,
      l2Usdc,
      ownerL2,
      overridesL2
    )
  ).wait()

  ///// verify initialization
  if (
    (await l1UsdcGateway.router()).toLowerCase() != l1Router.toLowerCase() ||
    (await l1UsdcGateway.inbox()).toLowerCase() != inbox.toLowerCase() ||
    (await l1UsdcGateway.l1USDC()).toLowerCase() != l1Usdc.toLowerCase() ||
    (await l1UsdcGateway.l2USDC()).toLowerCase() != l2Usdc.toLowerCase() ||
    (await l1UsdcGateway.owner()).toLowerCase() != _owner.toLowerCase() ||
    (await l1UsdcGateway.counterpartGateway()).toLowerCase() != _l2CounterPart.toLowerCase()
  ) {
    throw new Error('L1 USDC gateway initialization failed')
  }

  if (
    (await l2UsdcGateway.counterpartGateway()).toLowerCase() != _l1Counterpart.toLowerCase() ||
    (await l2UsdcGateway.router()).toLowerCase() != l2Router.toLowerCase() ||
    (await l2UsdcGateway.l1USDC()).toLowerCase() != l1Usdc.toLowerCase() ||
    (await l2UsdcGateway.l2USDC()).toLowerCase() != l2Usdc.toLowerCase() ||
    (await l2UsdcGateway.owner()).toLowerCase() != ownerL2.toLowerCase()
  ) {
    throw new Error('L2 USDC gateway initialization failed')
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
  l1UsdcGatewayAddress: string,
  parentOverrides: Overrides,
  childOverrides: Overrides
) {
  const isFeeToken =
    (await _getFeeToken(inbox, parentProvider)) != ethers.constants.AddressZero

  const l1RouterAddress = process.env['L1_ROUTER'] as string
  const l2RouterAddress = process.env['L2_ROUTER'] as string
  const l1UsdcAddress = process.env['L1_USDC'] as string

  const l1Router = isFeeToken
    ? L1OrbitGatewayRouter__factory.connect(l1RouterAddress, parentProvider)
    : L1GatewayRouter__factory.connect(l1RouterAddress, parentProvider)

  /// load upgrade executor
  const routerOwnerAddress = await l1Router.owner()
  if (!(await _isUpgradeExecutor(routerOwnerAddress, parentProvider))) {
    throw new Error('Router owner is expected to be an UpgradeExecutor')
  }
  const upgradeExecutor = UpgradeExecutor__factory.connect(
    routerOwnerAddress,
    parentProvider
  )

  /// prepare calldata for executor
  const routerRegistrationData =
    L2GatewayRouter__factory.createInterface().encodeFunctionData(
      'setGateway',
      [[l1UsdcAddress], [l1UsdcGatewayAddress]]
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
          [l1UsdcAddress],
          [l1UsdcGatewayAddress],
          maxGas,
          gasPriceBid,
          maxSubmissionCost,
          totalFee,
        ]
      )
    : L1GatewayRouter__factory.createInterface().encodeFunctionData(
        'setGateways(address[],address[],uint256,uint256,uint256)',
        [
          [l1UsdcAddress],
          [l1UsdcGatewayAddress],
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
        "executeCall",
        [
          feeTokenContract.address,
          feeTokenContract.interface.encodeFunctionData(
            'approve',
            [l1RouterAddress, totalFee]
          )
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
 * Master minter (this script set it to deployer) adds minter role to L2 gateway
 * with max allowance.
 */
async function _addMinterRoleToL2Gateway(
  l2UsdcGateway: L2USDCGateway,
  masterMinterOwner: SignerWithAddress,
  masterMinter: Contract,
  overrides: Overrides
) {
  await (
    await masterMinter['configureController(address,address)'](
      masterMinterOwner.address,
      l2UsdcGateway.address,
      overrides
    )
  ).wait()

  await (
    await masterMinter['configureMinter(uint256)'](ethers.constants.MaxUint256, overrides)
  ).wait()
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
  } catch {
    return false
  }

  return true
}

/**
 * Wait for L1->L2 message to be redeemed
 */
async function _waitOnL2Msg(tx: ContractTransaction, childProvider: Provider) {
  const retryableReceipt = await tx.wait()
  const l1TxReceipt = new L1TransactionReceipt(retryableReceipt)
  const messages = await l1TxReceipt.getL1ToL2Messages(childProvider)

  // 1 msg expected
  const messageResult = await messages[0].waitForStatus(undefined, 60 * 60 * 1000) // 1hr timeout
  const status = messageResult.status

  if (status != L1ToL2MessageStatus.REDEEMED) {
    throw new Error('L1->L2 message not redeemed')
  }
}

/**
 * Register L1 and L2 networks in the SDK
 * @param l1Provider
 * @param l2Provider
 * @param inboxAddress
 * @returns
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

  const rollupAddress = await IBridge__factory.connect(
    await IInboxBase__factory.connect(inboxAddress, l1Provider).bridge(),
    l1Provider
  ).rollup()
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

  return {
    l1Network,
    l2Network,
  }
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
    feeToken = await IERC20Bridge__factory.connect(
      bridge,
      provider
    ).nativeToken()
  } catch {
    // ignore
  }

  return feeToken
}

/**
 * Check if all required env vars are set
 */
function _checkEnvVars() {
  const requiredEnvVars = [
    'PARENT_RPC',
    'CHILD_RPC',
    'L1_ROUTER',
    'L2_ROUTER',
    'INBOX',
    'L1_USDC',
  ]

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing env var ${envVar}`)
    }
  }

  // Either raw key or KMS key must be set for each chain
  if (!process.env['PARENT_DEPLOYER_KEY'] && !process.env['PARENT_DEPLOYER_KMS_KEY']) {
    throw new Error('Missing env var: either PARENT_DEPLOYER_KEY or PARENT_DEPLOYER_KMS_KEY must be set')
  }
  if (!process.env['CHILD_DEPLOYER_KEY'] && !process.env['CHILD_DEPLOYER_KMS_KEY']) {
    throw new Error('Missing env var: either CHILD_DEPLOYER_KEY or CHILD_DEPLOYER_KMS_KEY must be set')
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
