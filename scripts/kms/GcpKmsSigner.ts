import { ethers } from 'ethers'
import { KeyManagementServiceClient } from '@google-cloud/kms'
import { createPublicKey } from 'crypto'

function parseDerEcdsaSig(der: Buffer): { r: bigint; s: bigint } {
  // DER SEQUENCE { INTEGER R, INTEGER S }
  // 30 LL [02 RL R...] [02 SL S...]
  // der is a fixed-format KMS response buffer, not user-controlled input.
  let offset = 2
  const firstLenByte = der.readUInt8(1)
  if (firstLenByte & 0x80) offset += firstLenByte & 0x7f  // long-form length (shouldn't happen for secp256k1)
  const rLen = der.readUInt8(offset + 1)
  const r = BigInt('0x' + der.slice(offset + 2, offset + 2 + rLen).toString('hex'))
  offset += 2 + rLen
  const sLen = der.readUInt8(offset + 1)
  const s = BigInt('0x' + der.slice(offset + 2, offset + 2 + sLen).toString('hex'))
  return { r, s }
}

function bigintToHex32(n: bigint): string {
  return '0x' + n.toString(16).padStart(64, '0')
}

export class GcpKmsSigner extends ethers.Signer {
  private _client: KeyManagementServiceClient
  private _keyName: string
  private _address?: string

  constructor(keyName: string, provider?: ethers.providers.Provider) {
    super()
    this._keyName = keyName
    this._client = new KeyManagementServiceClient()
    if (provider) ethers.utils.defineReadOnly(this, 'provider', provider)
  }

  async getAddress(): Promise<string> {
    if (this._address) return this._address
    const [resp] = await this._client.getPublicKey({ name: this._keyName })
    const pem = resp.pem as string
    // SPKI DER: last 65 bytes are the uncompressed EC point (0x04 + 32 + 32)
    const der = createPublicKey(pem).export({ format: 'der', type: 'spki' }) as Buffer
    const uncompressed = der.slice(der.length - 65)
    const hash = ethers.utils.keccak256(uncompressed.slice(1))
    this._address = ethers.utils.getAddress('0x' + hash.slice(-40))
    return this._address
  }

  async signTransaction(tx: ethers.providers.TransactionRequest): Promise<string> {
    const resolved = await ethers.utils.resolveProperties(tx)
    const serialized = ethers.utils.serializeTransaction(resolved as ethers.UnsignedTransaction)
    const digest = ethers.utils.arrayify(ethers.utils.keccak256(serialized))

    const [resp] = await this._client.asymmetricSign({
      name: this._keyName,
      digest: { sha256: digest },
    })
    const der = Buffer.from(resp.signature as Uint8Array)
    const { r, s } = parseDerEcdsaSig(der)

    const address = await this.getAddress()
    for (const v of [27, 28]) {
      const sig = ethers.utils.joinSignature({ r: bigintToHex32(r), s: bigintToHex32(s), v })
      if (ethers.utils.recoverAddress(digest, sig).toLowerCase() === address.toLowerCase()) {
        return ethers.utils.serializeTransaction(resolved as ethers.UnsignedTransaction, sig)
      }
    }
    throw new Error('GcpKmsSigner: could not determine recovery bit from KMS signature')
  }

  async signMessage(_message: ethers.utils.Bytes | string): Promise<string> {
    throw new Error('GcpKmsSigner: signMessage not implemented')
  }

  connect(provider: ethers.providers.Provider): GcpKmsSigner {
    return new GcpKmsSigner(this._keyName, provider)
  }
}

// Use KMS signing when kmsKey is set; fall back to a raw private key otherwise.
export function makeSigner(
  kmsKey: string | undefined,
  privateKey: string | undefined,
  provider: ethers.providers.Provider
): ethers.Signer {
  if (kmsKey) return new GcpKmsSigner(kmsKey, provider)
  if (privateKey) return new ethers.Wallet(privateKey, provider)
  throw new Error('Either a KMS key (DEPLOYER_KMS_KEY) or a raw private key env var must be set')
}
