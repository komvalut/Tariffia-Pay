import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddress,
  isHash,
  parseAbiItem,
  parseUnits,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type HttpTransport,
  type PublicClient,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import { config } from '../../config.js';
import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentRequest,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../../payment-adapter.js';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const metadataAbi = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint8' }],
}] as const;
type BaseRpcClient = PublicClient<HttpTransport, typeof base>;

export type DetectedUsdcTransfer = {
  transactionHash: Hash;
  recipientAddress: Address;
  amountBaseUnits: bigint;
  blockNumber: bigint;
};

export class BaseUsdcAdapter implements PaymentAdapter {
  readonly id = 'usdc';
  readonly network = 'base';
  readonly currency = 'USDC';
  readonly tokenAddress: Address;
  readonly chainId = base.id;
  private readonly client: BaseRpcClient;
  private tokenValidation?: Promise<string | null>;

  constructor(client?: BaseRpcClient) {
    this.tokenAddress = getAddress(config.USDC_TOKEN_ADDRESS);
    if (this.tokenAddress === zeroAddress) throw new Error('USDC token address cannot be the zero address');
    this.client = client ?? createPublicClient({
      chain: base,
      transport: http(config.BASE_RPC_URL, { retryCount: 2, timeout: 12_000 }),
    });
  }

  async createRequest(input: PaymentRequest): Promise<AdapterPaymentDetails> {
    if (input.currency.toUpperCase() !== this.currency) throw new Error(`Unsupported currency for ${this.id}: ${input.currency}`);
    if (!isAddress(input.recipient)) throw new Error('Payment recipient is not a valid EVM address');
    if (input.recipient.toLowerCase() === zeroAddress) throw new Error('Payment recipient cannot be the zero address');
    if (!/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/.test(input.amount) || /^0(?:\.0+)?$/.test(input.amount)) {
      throw new Error('USDC amount must be positive and have at most 6 decimal places');
    }
    const amountBaseUnits = parseUnits(input.amount, 6);
    if (amountBaseUnits <= 0n) throw new Error('USDC amount must be greater than zero');
    return {
      adapter: this.id,
      network: this.network,
      currency: this.currency,
      recipientAddress: getAddress(input.recipient),
      tokenAddress: this.tokenAddress,
      adapterData: {
        chainId: this.chainId,
        decimals: 6,
        amountBaseUnits: amountBaseUnits.toString(),
      },
    };
  }

  async verifyTransaction(input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    if (!isHash(input.transactionHash)) return { state: 'rejected', reason: 'Malformed transaction hash' };
    if (input.currency.toUpperCase() !== this.currency || input.network !== this.network) {
      return { state: 'rejected', reason: 'Payment asset or network does not match the USDC/Base adapter' };
    }
    if (!input.tokenAddress || input.tokenAddress.toLowerCase() !== this.tokenAddress.toLowerCase()) {
      return { state: 'rejected', reason: 'Payment token does not match configured Base USDC' };
    }
    if (!isAddress(input.recipientAddress)) return { state: 'rejected', reason: 'Invalid configured payment recipient' };

    const tokenConfigurationError = await this.validateTokenConfiguration();
    if (tokenConfigurationError) return { state: 'rejected', reason: tokenConfigurationError };

    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: input.transactionHash as Hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return { state: 'not_found' };
      throw error;
    }
    if (receipt.status !== 'success') return { state: 'rejected', reason: 'Transaction execution failed' };

    const recipient = input.recipientAddress.toLowerCase();
    const expectedAmount = parseUnits(input.amount, 6);
    let matchingTransfer = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.tokenAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
        if (decoded.eventName === 'Transfer' &&
            decoded.args.to.toLowerCase() === recipient &&
            decoded.args.value === expectedAmount) {
          matchingTransfer = true;
          break;
        }
      } catch {
        // Other events emitted by the token contract are not payment transfers.
      }
    }
    if (!matchingTransfer) {
      return { state: 'rejected', reason: 'No USDC Transfer log matches the configured token, recipient and exact amount' };
    }

    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (Number(block.timestamp) < Math.floor(input.createdAt.getTime() / 1000) - 60) {
      return { state: 'rejected', reason: 'Transfer predates the payment request' };
    }
    const head = await this.client.getBlockNumber();
    const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
    if (confirmations < config.USDC_MIN_CONFIRMATIONS) {
      return { state: 'pending', detected: true, confirmations, blockNumber: receipt.blockNumber };
    }
    return { state: 'verified', confirmations, blockNumber: receipt.blockNumber };
  }

  async getBlockNumber(): Promise<bigint> {
    const tokenConfigurationError = await this.validateTokenConfiguration();
    if (tokenConfigurationError) throw new Error(tokenConfigurationError);
    return this.client.getBlockNumber();
  }

  private async validateTokenConfiguration(): Promise<string | null> {
    if (!this.tokenValidation) {
      this.tokenValidation = (async () => {
        const chainId = await this.client.getChainId();
        if (chainId !== this.chainId) return `RPC chain ID ${chainId} is not Base (${this.chainId})`;
        const decimals = await this.client.readContract({ address: this.tokenAddress, abi: metadataAbi, functionName: 'decimals' });
        if (decimals !== 6) return `Configured token decimals are ${decimals}, expected 6`;
        return null;
      })().catch((error) => {
        this.tokenValidation = undefined;
        throw error;
      });
    }
    return this.tokenValidation;
  }

  async scanTransfers(fromBlock: bigint, toBlock: bigint): Promise<DetectedUsdcTransfer[]> {
    const logs = await this.client.getLogs({
      address: this.tokenAddress,
      event: transferEvent,
      fromBlock,
      toBlock,
    });
    return logs.flatMap((log) => {
      if (!log.args.to || log.args.value === undefined) return [];
      return [{
        transactionHash: log.transactionHash,
        recipientAddress: log.args.to,
        amountBaseUnits: log.args.value,
        blockNumber: log.blockNumber,
      }];
    });
  }
}
