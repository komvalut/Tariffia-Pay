import {
  createPublicClient,
  decodeFunctionData,
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
import { z } from 'zod';
import { config } from '../../config.js';
import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentAdapterManifest,
  PaymentRequest,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../../payment-adapter.js';
import { PaymentAdapterError } from '../../payment-adapters/errors.js';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const metadataAbi = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint8' }],
}] as const;
const transferFunction = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const;
type BaseRpcClient = PublicClient<HttpTransport, typeof base>;

const configurationSchema = z.object({
  rpcUrl: z.string().url(),
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  minimumConfirmations: z.number().int().min(1),
}).strict();

export function baseUsdcAdapterSettings(): Record<string, unknown> {
  return {
    rpcUrl: config.BASE_RPC_URL,
    tokenAddress: config.USDC_TOKEN_ADDRESS,
    minimumConfirmations: config.USDC_MIN_CONFIRMATIONS,
  };
}

const manifest: PaymentAdapterManifest = {
  id: 'usdc',
  name: 'Base USDC',
  version: '1.0.0',
  description: 'USDC payments verified on Base.',
  capabilities: {
    paymentRequests: true,
    transactionVerification: true,
    statusPolling: false,
    recurringPayments: false,
    automaticDetection: true,
    refunds: false,
    paymentRequestFormat: 'wallet',
    currencies: ['USDC'],
    networks: ['base'],
  },
  idempotency: {
    paymentCreation: 'stable-key-required',
    transactionVerification: 'network-and-transaction-id',
  },
};

export type DetectedUsdcTransfer = {
  transactionHash: Hash;
  recipientAddress: Address;
  amountBaseUnits: bigint;
  blockNumber: bigint;
};

export class BaseUsdcAdapter implements PaymentAdapter {
  readonly id = 'usdc';
  readonly manifest = manifest;
  readonly network = 'base';
  readonly currency = 'USDC';
  readonly chainId = base.id;
  private client: BaseRpcClient;
  private readonly injectedClient?: BaseRpcClient;
  private tokenAddress: Address;
  private minimumConfirmations: number;
  private started = true;
  private tokenValidation?: Promise<string | null>;

  constructor(client?: BaseRpcClient) {
    this.injectedClient = client;
    const settings = configurationSchema.parse(baseUsdcAdapterSettings());
    this.tokenAddress = getAddress(settings.tokenAddress);
    this.minimumConfirmations = settings.minimumConfirmations;
    if (this.tokenAddress === zeroAddress) throw new Error('USDC token address cannot be the zero address');
    this.client = client ?? this.createClient(settings.rpcUrl);
  }

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    const parsed = configurationSchema.safeParse(settings);
    if (!parsed.success || parsed.data.tokenAddress.toLowerCase() === zeroAddress) {
      throw new PaymentAdapterError('invalid_configuration', 'initialize', 'Base USDC adapter configuration is invalid');
    }
    this.tokenAddress = getAddress(parsed.data.tokenAddress);
    this.minimumConfirmations = parsed.data.minimumConfirmations;
    this.client = this.injectedClient ?? this.createClient(parsed.data.rpcUrl);
    this.tokenValidation = undefined;
    this.started = true;
  }

  async shutdown(): Promise<void> {
    this.started = false;
  }

  async health() {
    if (!this.started) return { status: 'unavailable' as const, message: 'Adapter is stopped' };
    try {
      const issue = await this.validateTokenConfiguration();
      return issue
        ? { status: 'degraded' as const, message: 'Configured Base USDC contract is not usable' }
        : { status: 'healthy' as const, message: 'Base RPC and USDC contract are available' };
    } catch {
      return { status: 'unavailable' as const, message: 'Base RPC health check failed' };
    }
  }

  normalizeTransactionId(transactionId: string): string {
    return transactionId.toLowerCase();
  }

  async createRequest(input: PaymentRequest): Promise<AdapterPaymentDetails> {
    if (input.currency.toUpperCase() !== this.currency) {
      throw new PaymentAdapterError('invalid_request', 'create_request', `Unsupported currency for ${this.id}: ${input.currency}`);
    }
    if (!isAddress(input.recipient)) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Payment recipient is not a valid EVM address');
    }
    if (input.recipient.toLowerCase() === zeroAddress) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Payment recipient cannot be the zero address');
    }
    if (!/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/.test(input.amount) || /^0(?:\.0+)?$/.test(input.amount)) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'USDC amount must be positive and have at most 6 decimal places');
    }
    const amountBaseUnits = parseUnits(input.amount, 6);
    if (amountBaseUnits <= 0n) throw new PaymentAdapterError('invalid_request', 'create_request', 'USDC amount must be greater than zero');
    return {
      adapter: this.id,
      network: this.network,
      currency: this.currency,
      recipientAddress: getAddress(input.recipient).toLowerCase(),
      tokenAddress: this.tokenAddress.toLowerCase(),
      amountBaseUnits: amountBaseUnits.toString(),
      adapterData: {
        chainId: this.chainId,
        decimals: 6,
      },
    };
  }

  async verifyTransaction(input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    if (!isHash(input.transactionId)) return { state: 'rejected', reason: 'Malformed transaction hash' };
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
      receipt = await this.client.getTransactionReceipt({ hash: input.transactionId as Hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return { state: 'not_found' };
      throw error;
    }
    const recipient = input.recipientAddress.toLowerCase();
    const expectedAmount = parseUnits(input.amount, 6);
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (Number(block.timestamp) < Math.floor(input.createdAt.getTime() / 1000) - 60) {
      return { state: 'rejected', reason: 'Transfer predates the payment request' };
    }
    if (receipt.status === 'reverted') {
      const transaction = await this.client.getTransaction({ hash: input.transactionId as Hash });
      if (transaction.to?.toLowerCase() !== this.tokenAddress.toLowerCase()) {
        return { state: 'rejected', reason: 'Reverted transaction did not call the configured USDC token' };
      }
      try {
        const decoded = decodeFunctionData({ abi: transferFunction, data: transaction.input });
        if (decoded.functionName !== 'transfer' ||
            decoded.args[0].toLowerCase() !== recipient || decoded.args[1] !== expectedAmount) {
          return { state: 'rejected', reason: 'Reverted transfer does not match recipient and exact amount' };
        }
      } catch {
        return { state: 'rejected', reason: 'Reverted transaction is not the expected USDC transfer' };
      }
      return {
        state: 'failed', reason: 'USDC transfer transaction reverted',
        receipt: this.toPaymentReceipt(input, 'failed', 0, receipt.blockNumber),
      };
    }

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

    const head = await this.client.getBlockNumber();
    const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
    if (confirmations < this.minimumConfirmations) {
      return {
        state: 'pending', detected: true,
        receipt: this.toPaymentReceipt(input, 'pending', confirmations, receipt.blockNumber),
      };
    }
    return {
      state: 'verified',
      receipt: this.toPaymentReceipt(input, 'confirmed', confirmations, receipt.blockNumber),
    };
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

  private createClient(rpcUrl: string): BaseRpcClient {
    return createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 2, timeout: 12_000 }) });
  }

  private toPaymentReceipt(
    input: PaymentVerificationInput,
    state: 'pending' | 'confirmed' | 'failed',
    confirmations: number,
    blockNumber: bigint | null,
  ) {
    return {
      transactionId: input.transactionId,
      network: this.network,
      state,
      amount: input.amount,
      currency: input.currency,
      recipient: input.recipientAddress,
      confirmations,
      blockNumber: blockNumber?.toString() ?? null,
    };
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
