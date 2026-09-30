import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  TransactionReceiptNotFoundError,
  type Hash,
} from 'viem';
import { BaseUsdcAdapter } from '../src/adapters/usdc/base-usdc-adapter.js';
import { config } from '../src/config.js';

const token = getAddress(config.USDC_TOKEN_ADDRESS);
const recipient = getAddress('0x2222222222222222222222222222222222222222');
const otherRecipient = getAddress('0x3333333333333333333333333333333333333333');
const transactionHash = `0x${'d'.repeat(64)}` as Hash;
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const transferFunction = [{
  type: 'function', name: 'transfer', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const;
const createdAt = new Date(1_700_000_000_000);

function adapterFixture(options: {
  chainId?: number;
  decimals?: number;
  amount?: bigint;
  transferRecipient?: `0x${string}`;
  transferToken?: `0x${string}`;
  receiptStatus?: 'success' | 'reverted';
  blockTimestamp?: bigint;
  head?: bigint;
  receiptMissing?: boolean;
} = {}) {
  const topics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: { from: recipient, to: options.transferRecipient ?? recipient },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [options.amount ?? 4_500_000n]);
  const receipt = {
    status: options.receiptStatus ?? 'success',
    blockNumber: 100n,
    logs: [{ address: options.transferToken ?? token, topics, data }],
  };
  const client = {
    getChainId: vi.fn().mockResolvedValue(options.chainId ?? 8453),
    readContract: vi.fn().mockResolvedValue(options.decimals ?? 6),
    getTransactionReceipt: options.receiptMissing
      ? vi.fn().mockRejectedValue(new TransactionReceiptNotFoundError({ hash: transactionHash }))
      : vi.fn().mockResolvedValue(receipt),
    getTransaction: vi.fn().mockResolvedValue({
      to: token,
      input: encodeFunctionData({ abi: transferFunction, functionName: 'transfer', args: [recipient, 4_500_000n] }),
    }),
    getBlock: vi.fn().mockResolvedValue({ timestamp: options.blockTimestamp ?? 1_700_000_000n }),
    getBlockNumber: vi.fn().mockResolvedValue(options.head ?? 111n),
    getLogs: vi.fn().mockResolvedValue([{
      address: options.transferToken ?? token,
      args: { to: options.transferRecipient ?? recipient, value: options.amount ?? 4_500_000n },
      transactionHash,
      blockNumber: 100n,
    }]),
  };
  const adapter = new BaseUsdcAdapter(client as unknown as ConstructorParameters<typeof BaseUsdcAdapter>[0]);
  return { adapter, client };
}

const input = {
  paymentId: 'payment-1',
  transactionHash,
  amount: '4.500000',
  currency: 'USDC',
  network: 'base',
  recipientAddress: recipient,
  tokenAddress: token,
  createdAt,
};

describe('Base USDC adapter', () => {
  it('creates exact 6-decimal Base USDC payment details for the merchant recipient', async () => {
    const { adapter } = adapterFixture();
    const details = await adapter.createRequest({
      paymentId: 'payment-1', amount: '4.50', currency: 'USDC', recipient, expiresAt: null,
    });
    expect(details).toMatchObject({
      adapter: 'usdc', network: 'base', currency: 'USDC',
      recipientAddress: recipient, tokenAddress: token,
      adapterData: { chainId: 8453, decimals: 6, amountBaseUnits: '4500000' },
    });
  });

  it('verifies chain, configured token, Transfer recipient, exact amount and confirmations', async () => {
    const { adapter } = adapterFixture();
    await expect(adapter.verifyTransaction(input)).resolves.toEqual({
      state: 'verified', confirmations: 12, blockNumber: 100n,
    });
  });

  it('waits until the configured confirmation depth before confirming', async () => {
    const { adapter } = adapterFixture({ head: 110n });
    await expect(adapter.verifyTransaction(input)).resolves.toEqual({
      state: 'pending', detected: true, confirmations: 11, blockNumber: 100n,
    });
  });

  it('extracts recipient, exact base units, block and tx hash from Base USDC Transfer logs', async () => {
    const { adapter, client } = adapterFixture();
    await expect(adapter.scanTransfers(90n, 100n)).resolves.toEqual([{
      transactionHash,
      recipientAddress: recipient,
      amountBaseUnits: 4_500_000n,
      blockNumber: 100n,
    }]);
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: token, fromBlock: 90n, toBlock: 100n,
    }));
  });

  it('rejects a non-Base RPC chain', async () => {
    const { adapter } = adapterFixture({ chainId: 1 });
    await expect(adapter.verifyTransaction(input)).resolves.toMatchObject({ state: 'rejected', reason: expect.stringContaining('not Base') });
  });

  it('rejects a configured token with decimals other than six', async () => {
    const { adapter } = adapterFixture({ decimals: 18 });
    await expect(adapter.verifyTransaction(input)).resolves.toMatchObject({ state: 'rejected', reason: expect.stringContaining('decimals') });
  });

  it('rejects the wrong configured token, recipient, or exact transfer amount', async () => {
    const wrongToken = getAddress('0x4444444444444444444444444444444444444444');
    const tokenFixture = adapterFixture();
    await expect(tokenFixture.adapter.verifyTransaction({ ...input, tokenAddress: wrongToken }))
      .resolves.toMatchObject({ state: 'rejected', reason: expect.stringContaining('configured Base USDC') });

    const recipientFixture = adapterFixture({ transferRecipient: otherRecipient });
    await expect(recipientFixture.adapter.verifyTransaction(input))
      .resolves.toMatchObject({ state: 'rejected', reason: expect.stringContaining('recipient and exact amount') });

    const amountFixture = adapterFixture({ amount: 4_499_999n });
    await expect(amountFixture.adapter.verifyTransaction(input))
      .resolves.toMatchObject({ state: 'rejected', reason: expect.stringContaining('recipient and exact amount') });
  });

  it('recognizes a matching reverted payment, rejects unrelated failures, and handles unmined transactions', async () => {
    const reverted = adapterFixture({ receiptStatus: 'reverted' });
    await expect(reverted.adapter.verifyTransaction(input))
      .resolves.toMatchObject({ state: 'failed', reason: 'USDC transfer transaction reverted', blockNumber: 100n });
    const unrelated = adapterFixture({ receiptStatus: 'reverted' });
    unrelated.client.getTransaction.mockResolvedValue({
      to: token,
      input: encodeFunctionData({ abi: transferFunction, functionName: 'transfer', args: [otherRecipient, 4_500_000n] }),
    });
    await expect(unrelated.adapter.verifyTransaction(input))
      .resolves.toMatchObject({ state: 'rejected', reason: 'Reverted transfer does not match recipient and exact amount' });
    const missing = adapterFixture({ receiptMissing: true });
    await expect(missing.adapter.verifyTransaction(input)).resolves.toEqual({ state: 'not_found' });
  });

  it('rejects a transfer mined before the payment was created', async () => {
    const { adapter } = adapterFixture({ blockTimestamp: 1_699_999_890n });
    await expect(adapter.verifyTransaction(input))
      .resolves.toMatchObject({ state: 'rejected', reason: 'Transfer predates the payment request' });
  });

  it('rejects unsupported asset/network combinations and malformed payment amounts', async () => {
    const { adapter } = adapterFixture();
    await expect(adapter.verifyTransaction({ ...input, network: 'ethereum' }))
      .resolves.toMatchObject({ state: 'rejected' });
    await expect(adapter.createRequest({
      paymentId: 'payment-1', amount: '1.0000001', currency: 'USDC', recipient, expiresAt: null,
    })).rejects.toThrow();
    await expect(adapter.createRequest({
      paymentId: 'payment-1', amount: '1.00', currency: 'USDC',
      recipient: '0x0000000000000000000000000000000000000000', expiresAt: null,
    })).rejects.toThrow('zero address');
  });
});
