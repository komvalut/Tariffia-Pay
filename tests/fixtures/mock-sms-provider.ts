import {
  SmsProviderError,
  type SmsDeliveryRequest,
  type SmsDeliveryResult,
  type SmsOtpRequest,
  type SmsProvider,
  type SmsProviderHealth,
} from '../../src/sms-provider.js';

type MockOptions = {
  segments?: number;
  segmentsAuthoritative?: boolean;
  providerCostUsd?: string | null;
  failure?: SmsProviderError;
  health?: SmsProviderHealth;
  configured?: boolean;
  nativeOtp?: boolean;
};

export class MockSmsProvider {
  readonly id = 'mock-sms';
  readonly manifest = {
    id: 'mock-sms',
    name: 'Mock SMS provider',
    version: '1.0.0',
    description: 'Deterministic provider used by the SMS integration tests',
    kind: 'http-sms' as const,
    capabilities: {
      sendSms: true, sendOtp: false, maxMessageLength: 1600,
      reportsSegments: true, reportsProviderCost: true,
    },
  };
  readonly smsCalls: SmsDeliveryRequest[] = [];
  readonly otpCalls: SmsOtpRequest[] = [];
  readonly initializations: Array<Record<string, unknown>> = [];
  initialized = false;
  shutDown = false;
  healthChecks = 0;
  options: MockOptions = {};

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    this.initializations.push({ ...settings });
    this.initialized = true;
    if (this.options.nativeOtp) {
      this.manifest.capabilities.sendOtp = true;
    }
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
  }

  isConfigured(): boolean {
    return this.options.configured ?? true;
  }

  async health(): Promise<SmsProviderHealth> {
    this.healthChecks += 1;
    return this.options.health ?? { status: 'healthy', message: 'Mock provider is ready' };
  }

  async sendSms(request: SmsDeliveryRequest): Promise<SmsDeliveryResult> {
    this.smsCalls.push(request);
    if (this.options.failure) throw this.options.failure;
    const segments = this.options.segments ?? 1;
    return {
      providerRequestId: request.requestId,
      providerMessageId: `msg_${request.requestId.replace(/[^A-Za-z0-9_.:-]/g, '')}`.slice(0, 128),
      status: 'sent',
      segments,
      segmentsAuthoritative: this.options.segmentsAuthoritative ?? true,
      providerCostUsd: this.options.providerCostUsd === undefined ? null : this.options.providerCostUsd,
    };
  }

  async sendOtp(request: SmsOtpRequest): Promise<SmsDeliveryResult> {
    this.otpCalls.push(request);
    if (this.options.failure) throw this.options.failure;
    const segments = this.options.segments ?? 1;
    return {
      providerRequestId: request.requestId,
      providerMessageId: `otp_${request.requestId.replace(/[^A-Za-z0-9_.:-]/g, '')}`.slice(0, 128),
      status: 'sent',
      segments,
      segmentsAuthoritative: this.options.segmentsAuthoritative ?? true,
      providerCostUsd: this.options.providerCostUsd === undefined ? null : this.options.providerCostUsd,
    };
  }
}
