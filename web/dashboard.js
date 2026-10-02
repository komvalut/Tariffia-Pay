const role = document.body.dataset.dashboard;
const app = document.querySelector('#app');
let credential = '';
let currentPage = 'overview';
let activeFilter = { page: 1, q: '', status: '' };
let searchTimer;
const adminKeyHeader = 'x-admin-api-key';

const navItems = {
  admin: [
    ['overview', 'Overview'], ['merchants', 'Merchants'], ['customers', 'Customers'], ['orders', 'Orders'],
    ['payments', 'Payments'], ['usdc-transactions', 'USDC transactions'], ['credit-accounts', 'Credit accounts'],
    ['credit-transactions', 'Credit transactions'], ['ai-providers', 'AI providers'], ['ai-models', 'Models & pricing'],
    ['usage', 'Usage & margins'], ['webhook-endpoints', 'Webhook endpoints'], ['webhook-deliveries', 'Delivery logs'],
    ['failed-payments', 'Failed / expired'], ['health', 'System health'],
  ],
  merchant: [
    ['overview', 'Overview'], ['api-usage', 'API usage'], ['api-keys', 'API keys'], ['customers', 'Customers'], ['orders', 'Orders'], ['payments', 'Payments'],
    ['transactions', 'Transactions'],
    ['payment-links', 'Payment links'], ['credit-accounts', 'Credit balances'], ['topups', 'Credit top-ups'],
    ['ai-models', 'AI models'], ['usage', 'Usage & cost'], ['webhooks', 'Webhooks'],
    ['webhook-endpoints', 'Webhook settings'], ['webhook-deliveries', 'Delivery history'], ['settings', 'Settings'],
  ],
};

const tables = {
  admin: {
    merchants: { title: 'Merchants', endpoint: 'merchants', description: 'Provisioned merchant accounts and operating status.', columns: [['name', 'Merchant'], ['email', 'Email'], ['walletAddress', 'USDC wallet'], ['status', 'Status'], ['customerCount', 'Customers'], ['createdAt', 'Created']] , filter: ['active', 'suspended'] },
    customers: { title: 'Customers', endpoint: 'customers', description: 'Customer records across the platform.', columns: [['customer', 'Customer'], ['email', 'Email'], ['externalId', 'External ID'], ['merchant', 'Merchant'], ['createdAt', 'Created']] },
    orders: { title: 'Orders', endpoint: 'orders', description: 'Orders and their current payment state.', columns: [['description', 'Order'], ['merchant', 'Merchant'], ['customer', 'Customer'], ['amount', 'Amount'], ['status', 'Order'], ['paymentStatus', 'Payment'], ['createdAt', 'Created']], filter: ['CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'] },
    payments: { title: 'Payments', endpoint: 'payments', description: 'USDC payment requests, confirmations and failures.', columns: [['id', 'Payment ID'], ['merchant', 'Merchant'], ['description', 'Description'], ['amount', 'Amount'], ['status', 'Status'], ['transactionHash', 'Transaction'], ['createdAt', 'Created']], filter: ['PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED'] },
    'usdc-transactions': { title: 'USDC transactions', endpoint: 'usdc-transactions', description: 'On-chain transaction hashes recorded against confirmed payment requests.', columns: [['transactionHash', 'Transaction hash'], ['merchant', 'Merchant'], ['amount', 'Amount'], ['network', 'Network'], ['confirmedAt', 'Confirmed']] },
    'failed-payments': { title: 'Failed and expired payments', endpoint: 'failed-payments', description: 'Payments requiring review. No payment state is modified here.', columns: [['merchant', 'Merchant'], ['description', 'Description'], ['amount', 'Amount'], ['status', 'Status'], ['failureReason', 'Reason'], ['transactionHash', 'Transaction'], ['updatedAt', 'Updated']], filter: ['FAILED', 'EXPIRED'] },
    'credit-accounts': { title: 'Credit accounts', endpoint: 'credit-accounts', description: 'Shared internal balances used for merchant customer usage.', columns: [['merchant', 'Merchant'], ['customer', 'Customer'], ['balanceUnits', 'Balance'], ['updatedAt', 'Updated']] },
    'credit-transactions': { title: 'Credit transactions', endpoint: 'credit-transactions', description: 'Existing credit-engine top-ups and deductions.', columns: [['merchant', 'Merchant'], ['customer', 'Customer'], ['type', 'Type'], ['creditUnits', 'Amount'], ['balanceAfterUnits', 'Balance after'], ['reference', 'Reference'], ['createdAt', 'Created']], filter: ['TOPUP', 'DEDUCTION'] },
    'ai-providers': { title: 'AI providers', endpoint: 'ai-providers', description: 'Provider labels and enabled state. Provider credentials are not accepted or stored.', columns: [['name', 'Provider'], ['slug', 'Slug'], ['enabled', 'Enabled'], ['createdAt', 'Created']], actions: 'provider' },
    'ai-models': { title: 'Models and pricing', endpoint: 'ai-models', description: 'Provider costs, customer prices, markup and model activation.', columns: [['provider', 'Provider'], ['name', 'Model'], ['pricingMode', 'Mode'], ['providerCostPerRequestUsd', 'Provider / request'], ['customerPricePerRequestUsd', 'Customer / request'], ['providerInputCostPer1kUsd', 'Input cost / 1k'], ['customerInputPricePer1kUsd', 'Input price / 1k'], ['providerOutputCostPer1kUsd', 'Output cost / 1k'], ['customerOutputPricePer1kUsd', 'Output price / 1k'], ['markupBps', 'Markup bps'], ['enabled', 'Enabled']], actions: 'model' },
    usage: { title: 'Usage and margins', endpoint: 'usage', description: 'Recorded AI usage, customer charges, provider costs and profit.', columns: [['merchant', 'Merchant'], ['customer', 'Customer'], ['provider', 'Provider'], ['model', 'Model'], ['requestId', 'Request'], ['inputTokens', 'Input'], ['outputTokens', 'Output'], ['providerCostUsd', 'Provider cost'], ['customerPriceUsd', 'Revenue'], ['profitUsd', 'Profit'], ['createdAt', 'Created']] },
    'webhook-endpoints': { title: 'Webhook endpoints', endpoint: 'webhook-endpoints', description: 'Merchant delivery destinations. Only the origin is shown to reduce accidental disclosure of URL credentials.', columns: [['merchant', 'Merchant'], ['name', 'Endpoint'], ['origin', 'Origin'], ['events', 'Events'], ['enabled', 'Enabled'], ['createdAt', 'Created']] },
    'webhook-deliveries': { title: 'Webhook delivery logs', endpoint: 'webhook-deliveries', description: 'Queued and attempted event deliveries across merchants.', columns: [['merchant', 'Merchant'], ['endpoint', 'Endpoint'], ['event', 'Event'], ['status', 'Status'], ['attempts', 'Attempts'], ['lastHttpStatus', 'HTTP'], ['lastError', 'Last error'], ['createdAt', 'Created']], filter: ['QUEUED', 'DELIVERING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELLED'], actions: 'admin-attempts' },
  },
  merchant: {
    customers: { title: 'Customers', endpoint: 'customers', description: 'Your customer records. Customer creation uses the existing customer API.', columns: [['name', 'Name'], ['email', 'Email'], ['externalId', 'External ID'], ['createdAt', 'Created']], form: 'customer', actions: 'customer' },
    orders: { title: 'Orders', endpoint: 'orders', description: 'Orders created through the existing Payment Core.', columns: [['description', 'Order'], ['customer', 'Customer'], ['reference', 'Reference'], ['amount', 'Amount'], ['status', 'Order'], ['paymentStatus', 'Payment'], ['createdAt', 'Created']], filter: ['CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'], actions: 'order' },
    payments: { title: 'Payments', endpoint: 'payments', description: 'Payment state and verified Base transaction hashes.', columns: [['description', 'Description'], ['amount', 'Amount'], ['network', 'Network'], ['status', 'Status'], ['transactionHash', 'Transaction'], ['failureReason', 'Reason'], ['createdAt', 'Created']], filter: ['PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED'] },
    'payment-links': { title: 'Payment links', endpoint: 'payment-links', description: 'Hosted links backed by the same order and payment records. Pausing or deleting a link only affects the link, not the payment.', columns: [['description', 'Description'], ['amount', 'Amount'], ['currency', 'Currency'], ['status', 'Payment'], ['enabled', 'Link'], ['expiresAt', 'Expires'], ['createdAt', 'Created'], ['paymentId', 'Checkout']], filter: ['PENDING', 'DETECTED', 'CONFIRMED', 'FAILED', 'EXPIRED'], form: 'payment-link', actions: 'payment-link' },
    'credit-accounts': { title: 'Credit balances', endpoint: 'credit-accounts', description: 'Per-customer balances from the existing Credit Engine.', columns: [['name', 'Customer'], ['email', 'Email'], ['externalId', 'External ID'], ['balanceUnits', 'Balance'], ['updatedAt', 'Updated']], form: 'topup' },
    topups: { title: 'Credit top-ups', endpoint: 'topups', description: 'USDC-backed top-ups and their existing payment status.', columns: [['customer', 'Customer'], ['amountUsdc', 'USDC'], ['creditUnits', 'Credits'], ['status', 'Status'], ['transactionHash', 'Transaction'], ['failureReason', 'Reason'], ['createdAt', 'Created']], filter: ['PENDING', 'CREDITED', 'FAILED', 'EXPIRED'] },
    usage: { title: 'AI usage and cost', endpoint: 'usage', description: 'Your reported requests and customer charges. Provider costs and platform margins are not shown to merchants.', columns: [['customer', 'Customer'], ['provider', 'Provider'], ['model', 'Model'], ['requestId', 'Request'], ['inputTokens', 'Input'], ['outputTokens', 'Output'], ['customerPriceUsd', 'Usage cost'], ['creditsDeductedUnits', 'Credits'], ['createdAt', 'Created']] },
    'webhook-endpoints': { title: 'Webhook endpoints', endpoint: 'webhook-endpoints', description: 'Manage destinations using the existing webhook API. Secrets are never displayed after submission.', columns: [['name', 'Endpoint'], ['url', 'Destination'], ['events', 'Events'], ['enabled', 'Enabled'], ['createdAt', 'Created']], form: 'webhook', actions: 'merchant-webhook' },
    'webhook-deliveries': { title: 'Webhook delivery history', endpoint: 'webhook-deliveries', description: 'Your delivery attempts and response status.', columns: [['endpoint', 'Endpoint'], ['event', 'Event'], ['status', 'Status'], ['attempts', 'Attempts'], ['lastHttpStatus', 'HTTP'], ['lastError', 'Last error'], ['createdAt', 'Created']], filter: ['QUEUED', 'DELIVERING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELLED'], actions: 'merchant-attempts' },
  },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function authHeaders(extra = {}) {
  return role === 'admin'
    ? { ...extra, [adminKeyHeader]: credential }
    : { ...extra, authorization: `Bearer ${credential}` };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: authHeaders({ ...(options.headers ?? {}), ...(options.body ? { 'content-type': 'application/json' } : {}) }),
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      credential = '';
      showLogin('Your session has expired. Sign in again.');
    }
    throw new Error(body.message ?? `Request failed (${response.status})`);
  }
  return body;
}

function formatCredits(units) {
  try {
    const value = BigInt(units ?? 0);
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  } catch { return '0'; }
}

function formatMoney(value, currency = 'USD') {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  if (currency === 'USDC') return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(amount)} USDC`;
  if (currency === 'CREDITS') return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(amount)} credits`;
  const maximumFractionDigits = currency === 'CREDITS' ? 6 : currency === 'USD' ? 8 : 6;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits }).format(amount);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function stat(label, value, foot = '') {
  return `<article class="stat-card"><div class="stat-label"><span>${esc(label)}</span><span class="nav-mark">/</span></div><div class="stat-value">${esc(value)}</div><div class="stat-foot">${esc(foot)}</div></article>`;
}

async function renderMerchantApiUsage(container) {
  const response = await api('/v1/usage');
  const usage = response.usage ?? {};
  const categories = [
    ['general', 'General API', 'All merchant API requests'],
    ['ai', 'AI requests', '/v1/ai endpoints'],
    ['sms', 'SMS requests', '/v1/sms endpoints'],
  ];
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Merchant data</div><h1>API usage</h1><p>Your request limits for the current window. Only your own usage is shown.</p></div><button class="button" data-refresh-usage>Refresh</button></div>
    <div class="stats-grid">${categories.map(([key, label, note]) => {
      const entry = usage[key] ?? {};
      const used = Number(entry.used ?? 0);
      const unlimited = entry.unlimited === true;
      const limit = unlimited ? null : (entry.limit ?? null);
      const remaining = unlimited ? null : Number(entry.remaining ?? 0);
      const percent = (!unlimited && limit) ? Math.min(100, Math.round((used / limit) * 100)) : 0;
      const value = unlimited ? `${used} / Unlimited` : `${used} / ${limit}`;
      const foot = unlimited ? 'Unlimited requests' : `${remaining} remaining`;
      return `<article class="stat-card"><div class="stat-label"><span>${esc(label)}</span><span class="nav-mark">/</span></div>
        <div class="stat-value">${esc(value)}</div>
        <div class="usage-track" role="progressbar" aria-valuemin="0" aria-valuemax="${limit ?? 0}" aria-valuenow="${used}" aria-label="${esc(label)} usage"><span class="usage-fill${percent >= 100 ? ' full' : ''}" style="width:${percent}%"></span></div>
        <div class="stat-foot">${esc(foot)} · resets ${esc(formatDate(entry.windowResetAt))}<br>${esc(note)}</div></article>`;
    }).join('')}</div>`;
  container.querySelector('[data-refresh-usage]').addEventListener('click', () => openPage('api-usage'));
}

async function renderMerchantApiKeys(container) {
  const response = await api('/v1/api-keys');
  const keys = response.apiKeys ?? [];
  const rows = keys.map((key) => `<tr>
      <td>${esc(key.name)}</td>
      <td>${esc(key.status === 'active' ? 'Active' : 'Revoked')}</td>
      <td><span class="mono">${esc(key.prefix)}…</span></td>
      <td>${esc(formatDate(key.createdAt))}</td>
      <td>${esc(key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never')}</td>
      <td>${key.status === 'active' ? `<button class="button small danger" data-revoke-key="${esc(key.id)}">Revoke</button>` : '—'}</td>
    </tr>`).join('');
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Merchant data</div><h1>API keys</h1><p>Keys for your account only. The full secret is shown once at creation and never again.</p></div><button class="button" data-refresh-keys>Refresh</button></div>
    <section class="panel form-panel"><div class="panel-head"><div><h2>Create an API key</h2><p>Give the key a name so you can recognise it later.</p></div></div>
      <form data-form="api-key" class="form-grid"><label class="field span-2"><span>Key name</span><input name="name" maxlength="80" required></label><div class="form-actions"><button class="button primary">Create key</button><span class="notice" data-notice></span></div></form></section>
    <section class="panel"><div class="panel-head"><div><h2>Your keys</h2><p>Revoking a key invalidates it immediately.</p></div></div>
      ${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state">No API keys yet.</div>'}</section>`;

  container.querySelector('[data-refresh-keys]').addEventListener('click', () => openPage('api-keys'));
  container.querySelectorAll('[data-revoke-key]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Revoke this API key? Requests using it will stop working immediately.')) return;
    button.disabled = true;
    try {
      await api(`/v1/api-keys/${encodeURIComponent(button.dataset.revokeKey)}`, { method: 'DELETE' });
      notify('API key revoked.');
      await openPage('api-keys');
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
  container.querySelector('form[data-form="api-key"]')?.addEventListener('submit', async (event) => {    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const notice = form.querySelector('[data-notice]');
    const name = new FormData(form).get('name');
    button.disabled = true; notice.className = 'notice'; notice.textContent = 'Creating…';
    try {
      const created = await api('/v1/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
      form.reset();
      showModal('API key created', `<p>Store this secret now. It is shown only once and only its hash is stored.</p><pre class="mono" data-revealed-secret>${esc(created.secret)}</pre><p class="notice">${esc(created.warning ?? '')}</p>`, 'API key');
      notify('API key created. Copy the secret now.');
      await openPage('api-keys');
    } catch (error) {
      notice.className = 'notice error'; notice.textContent = error.message; button.disabled = false;
    }
  });
}

const WEBHOOK_EVENT_TYPES = [
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired', 'order.paid',
  'credit.topup', 'credit.deducted', 'ai.usage.recorded', 'invoice.issued', 'receipt.issued',
  'subscription.created', 'subscription.activated', 'subscription.paused', 'subscription.resumed',
  'subscription.cancelled', 'subscription.past_due', 'subscription.expired',
  'subscription.billing_cycle.created', 'subscription.billing_cycle.paid', 'subscription.billing_cycle.failed',
  'ai.request.completed', 'ai.request.failed', 'sms.request.completed', 'sms.request.failed',
];

async function renderMerchantWebhooks(container) {
  const [endpointsResponse, deliveriesResponse] = await Promise.all([
    api('/v1/webhooks'),
    api('/v1/dashboard/webhook-deliveries?limit=25').catch(() => ({ items: [] })),
  ]);
  const endpoints = endpointsResponse.endpoints ?? [];
  const deliveries = deliveriesResponse.items ?? [];
  const eventBoxes = WEBHOOK_EVENT_TYPES.map((event) =>
    `<label class="check-chip"><input type="checkbox" name="events" value="${esc(event)}"><span>${esc(event)}</span></label>`).join('');
  const endpointRows = endpoints.map((endpoint) => `<tr>
      <td>${esc(endpoint.name)}</td>
      <td><span class="mono" title="${esc(endpoint.url)}">${esc(endpoint.url)}</span></td>
      <td>${esc((endpoint.events ?? []).join(', '))}</td>
      <td><span class="pill ${endpoint.enabled ? 'good' : 'bad'}">${endpoint.enabled ? 'Enabled' : 'Paused'}</span></td>
      <td>${esc(formatDate(endpoint.createdAt))}</td>
      <td><button class="button small" data-wh-toggle="${esc(endpoint.id)}" data-enabled="${endpoint.enabled}">${endpoint.enabled ? 'Pause' : 'Resume'}</button>
        <button class="button small danger" data-wh-delete="${esc(endpoint.id)}">Delete</button></td>
    </tr>`).join('');
  const deliveryRows = deliveries.map((delivery) => `<tr>
      <td>${esc(delivery.endpoint ?? '—')}</td>
      <td><span class="pill ${statusTone(delivery.status)}">${esc(delivery.status)}</span></td>
      <td>${esc(delivery.event ?? '—')}</td>
      <td>${esc(delivery.attempts ?? 0)}</td>
      <td>${esc(delivery.lastHttpStatus ?? '—')}</td>
      <td>${esc(delivery.lastError ?? '—')}</td>
      <td>${esc(formatDate(delivery.createdAt))}</td>
    </tr>`).join('');
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Merchant data</div><h1>Webhooks</h1><p>Your signed event endpoints and recent deliveries. Signing secrets are never shown again.</p></div><button class="button" data-refresh-webhooks>Refresh</button></div>
    <section class="panel form-panel"><div class="panel-head"><div><h2>Add a webhook endpoint</h2><p>Choose the events to receive. The signing secret is stored encrypted and never returned.</p></div></div>
      <form data-form="webhook" class="form-grid"><label class="field"><span>Name</span><input name="name" maxlength="100" required></label>
        <label class="field span-2"><span>HTTPS endpoint</span><input name="url" type="url" placeholder="https://merchant.example/hooks" required></label>
        <label class="field span-2"><span>Signing secret</span><input name="secret" type="password" minlength="32" maxlength="256" autocomplete="new-password" required></label>
        <div class="field span-2"><span>Events</span><div class="check-grid">${eventBoxes}</div></div>
        <div class="form-actions"><button class="button primary">Save endpoint</button><span class="notice" data-notice></span></div></form></section>
    <section class="panel"><div class="panel-head"><div><h2>Endpoints</h2><p>Pausing cancels queued deliveries for the endpoint.</p></div></div>
      ${endpoints.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>${endpointRows}</tbody></table></div>` : '<div class="empty-state">No webhook endpoints yet.</div>'}</section>
    <section class="panel"><div class="panel-head"><div><h2>Recent deliveries</h2><p>Latest delivery attempts across your endpoints.</p></div></div>
      ${deliveries.length ? `<div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Status</th><th>Event</th><th>Attempts</th><th>HTTP</th><th>Last error</th><th>Created</th></tr></thead><tbody>${deliveryRows}</tbody></table></div>` : '<div class="empty-state">No deliveries recorded yet.</div>'}</section>`;

  container.querySelector('[data-refresh-webhooks]').addEventListener('click', () => openPage('webhooks'));
  container.querySelectorAll('[data-wh-toggle]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/v1/webhooks/${encodeURIComponent(button.dataset.whToggle)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' }),
      });
      notify('Webhook endpoint updated.');
      await openPage('webhooks');
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
  container.querySelectorAll('[data-wh-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Delete this webhook endpoint? Queued deliveries will be cancelled.')) return;
    button.disabled = true;
    try {
      await api(`/v1/webhooks/${encodeURIComponent(button.dataset.whDelete)}`, { method: 'DELETE' });
      notify('Webhook endpoint deleted.');
      await openPage('webhooks');
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
  container.querySelector('form[data-form="webhook"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const notice = form.querySelector('[data-notice]');
    const data = new FormData(form);
    const events = data.getAll('events');
    button.disabled = true; notice.className = 'notice'; notice.textContent = 'Saving…';
    try {
      if (!events.length) throw new Error('Select at least one event.');
      await api('/v1/webhooks', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), url: data.get('url'), secret: data.get('secret'), events }),
      });
      notice.className = 'notice success'; notice.textContent = 'Endpoint saved.';
      notify('Webhook endpoint created.');
      await openPage('webhooks');
    } catch (error) {
      notice.className = 'notice error'; notice.textContent = error.message; button.disabled = false;
    }
  });
}

const TRANSACTION_STATUSES = ['CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED'];

async function renderMerchantTransactions(container) {
  const filters = { status: '', network: '' };
  const load = async () => {
    const params = new URLSearchParams({ limit: '50' });
    if (filters.status) params.set('status', filters.status);
    if (filters.network) params.set('network', filters.network);
    return api(`/v1/transactions?${params.toString()}`);
  };
  const render = async () => {
    const response = await load();
    const transactions = response.transactions ?? [];
    const rows = transactions.map((transaction) => `<tr>
        <td>${esc(transaction.description ?? '—')}</td>
        <td>${esc(formatMoney(transaction.amount, transaction.currency ?? 'USDC'))}</td>
        <td><span class="pill ${statusTone(transaction.status)}">${esc(transaction.status)}</span></td>
        <td>${esc(transaction.network ?? '—')}</td>
        <td>${transaction.transactionHash ? `<span class="mono" title="${esc(transaction.transactionHash)}">${esc(String(transaction.transactionHash).slice(0, 13))}…${esc(String(transaction.transactionHash).slice(-8))}</span>` : '—'}</td>
        <td>${esc(formatDate(transaction.createdAt))}</td>
        <td>${esc(transaction.confirmedAt ? formatDate(transaction.confirmedAt) : '—')}</td>
        <td><button class="button small" data-transaction-detail="${esc(transaction.paymentId)}">Details</button></td>
      </tr>`).join('');
    container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Merchant data</div><h1>Transactions</h1><p>Your payments across the configured networks. No private keys or secrets are shown.</p></div><button class="button" data-refresh-transactions>Refresh</button></div>
      <section class="panel"><div class="toolbar">
        <label class="field filter-field"><span>Status</span><select data-tx-status><option value="">All</option>${TRANSACTION_STATUSES.map((status) => `<option value="${status}"${filters.status === status ? ' selected' : ''}>${status}</option>`).join('')}</select></label>
        <label class="field filter-field"><span>Network</span><input data-tx-network placeholder="base" value="${esc(filters.network)}"></label>
        <button class="button" data-tx-apply>Apply filters</button></div>
        ${transactions.length ? `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Amount</th><th>Status</th><th>Network</th><th>Transaction</th><th>Created</th><th>Confirmed</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state">No transactions match these filters.</div>'}</section>`;
    container.querySelector('[data-refresh-transactions]').addEventListener('click', render);
    container.querySelector('[data-tx-status]').addEventListener('change', (event) => { filters.status = event.target.value; render(); });
    container.querySelector('[data-tx-network]').addEventListener('change', (event) => { filters.network = event.target.value.trim(); render(); });
    container.querySelector('[data-tx-apply]').addEventListener('click', () => {
      filters.status = container.querySelector('[data-tx-status]').value;
      filters.network = container.querySelector('[data-tx-network]').value.trim();
      render();
    });
    container.querySelectorAll('[data-transaction-detail]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const paymentId = button.dataset.transactionDetail;
        const [result, details] = await Promise.all([
          api(`/v1/transactions/${encodeURIComponent(paymentId)}`),
          api(`/v1/payments/${encodeURIComponent(paymentId)}/details`).catch(() => null),
        ]);
        const transaction = result.transaction ?? {};
        const payment = details?.payment ?? {};
        const order = details?.order ?? {};
        const invoice = details?.invoice ?? null;
        const receipt = details?.receipt ?? invoice?.receipt ?? null;
        const fields = [
          ['Transaction ID', transaction.transactionId ?? '—'], ['Payment ID', transaction.paymentId],
          ['Order ID', order.id ?? transaction.orderId], ['Description', order.description ?? transaction.description ?? '—'],
          ['Amount', formatMoney(payment.amount ?? transaction.amount, payment.currency ?? transaction.currency ?? 'USDC')],
          ['Status', payment.status ?? transaction.status], ['Payment method', payment.paymentMethod?.name ?? transaction.adapter ?? '—'],
          ['Network', payment.network ?? transaction.network ?? '—'],
          ['Order status', order.status ?? '—'], ['Order reference', order.reference ?? '—'],
          ['Invoice number', invoice?.invoiceNumber ?? 'Not issued'],
          ['Detected', payment.detectedAt ? formatDate(payment.detectedAt) : '—'],
          ['Confirmed', payment.confirmedAt ? formatDate(payment.confirmedAt) : '—'],
          ['Created', formatDate(payment.createdAt ?? transaction.createdAt)],
        ];
        const links = [];
        if (receipt?.publicId) links.push(`<a class="inline-link" href="/r/${encodeURIComponent(receipt.publicId)}" target="_blank" rel="noreferrer">Open receipt</a>`);
        if (invoice?.invoiceNumber) links.push(`<button class="button small" data-invoice-pdf="${esc(invoice.invoiceNumber)}">Download invoice PDF</button>`);
        const body = `<div class="table-wrap"><table><tbody>${fields.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value ?? '—')}</td></tr>`).join('')}</tbody></table></div>${links.length ? `<div class="form-actions">${links.join(' ')}</div>` : ''}`;
        showModal('Transaction details', body, 'Transaction');
        document.querySelector('.modal-backdrop [data-invoice-pdf]')?.addEventListener('click', async (event) => {
          const target = event.currentTarget;
          target.disabled = true;
          try {
            const response = await fetch(`/v1/invoices/${encodeURIComponent(target.dataset.invoicePdf)}.pdf`, { cache: 'no-store', headers: authHeaders() });
            if (!response.ok) throw new Error('Invoice download failed');
            const blob = await response.blob();
            window.open(URL.createObjectURL(blob), '_blank');
          } catch (error) { notify(error.message); } finally { target.disabled = false; }
        });
      } catch (error) { notify(error.message); } finally { button.disabled = false; }
    }));
  };
  await render();
}

async function renderMerchantSettings(container) {
  const response = await api('/v1/settings');
  const settings = response.settings ?? {};
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Merchant data</div><h1>Settings</h1><p>Non-sensitive business preferences for your account. API keys, secrets and payment configuration are never edited here.</p></div></div>
    <section class="panel form-panel"><div class="panel-head"><div><h2>Business settings</h2><p>Display name, support email, default currency and timezone.</p></div></div>
      <form data-form="settings" class="form-grid">
        <label class="field"><span>Display name</span><input name="displayName" maxlength="120" value="${esc(settings.displayName ?? '')}" required></label>
        <label class="field"><span>Support email</span><input name="supportEmail" type="email" maxlength="254" value="${esc(settings.supportEmail ?? '')}" placeholder="support@example.com"></label>
        <label class="field"><span>Default currency</span><input name="defaultCurrency" maxlength="12" value="${esc(settings.defaultCurrency ?? 'USDC')}" placeholder="USDC"></label>
        <label class="field"><span>Timezone</span><input name="timezone" maxlength="64" value="${esc(settings.timezone ?? 'UTC')}" placeholder="UTC"></label>
        <div class="form-actions"><button class="button primary">Save settings</button><span class="notice" data-notice></span></div>
      </form></section>`;
  container.querySelector('form[data-form="settings"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const notice = form.querySelector('[data-notice]');
    const values = Object.fromEntries(new FormData(form).entries());
    button.disabled = true; notice.className = 'notice'; notice.textContent = 'Saving…';
    try {
      await api('/v1/settings', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: values.displayName?.trim() || null,
          supportEmail: values.supportEmail?.trim() || null,
          defaultCurrency: values.defaultCurrency?.trim() || null,
          timezone: values.timezone?.trim() || null,
        }),
      });
      notice.className = 'notice success'; notice.textContent = 'Settings saved.';
      notify('Settings saved.');
    } catch (error) {
      notice.className = 'notice error'; notice.textContent = error.message;
    } finally { button.disabled = false; }
  });
}

function setTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem('tariffia-theme', theme);
  const button = document.querySelector('[data-theme-toggle]');
  if (button) button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  if (button) button.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

function showLogin(message = '') {
  const admin = role === 'admin';
  app.innerHTML = `<div class="login-shell">
    <section class="login-art"><div class="brand"><span class="brand-mark">T</span><span>Tariffia <span style="font-weight:400">Pay</span></span></div>
      <div><div class="eyebrow">${admin ? 'Platform operations' : 'Merchant workspace'}</div><h1>${admin ? 'A clearer view of the payment rail.' : 'Your payments, in one place.'}</h1>
      <p>${admin ? 'Monitor payments, internal balances, reseller usage and webhook delivery health.' : 'Follow your orders, payment links, credit balances, AI usage and event deliveries.'}</p></div>
      <div class="eyebrow">Non-custodial payments · Base USDC</div></section>
    <section class="login-panel"><div class="eyebrow">${admin ? 'Administrator sign-in' : 'Merchant sign-in'}</div>
      <h2>Open your dashboard</h2><p>${admin ? 'Use the server-side admin credential. It stays in this browser tab memory only.' : 'Use a merchant API key for your account. It is not saved after you close or reload this tab.'}</p>
      <form id="login-form"><label class="field">${admin ? 'Admin API key' : 'Merchant API key'}<input id="credential" name="credential" type="password" autocomplete="current-password" required spellcheck="false" placeholder="${admin ? 'Enter admin key' : 'tf_live_…'}"></label>
        <button class="button primary" type="submit">Continue</button><div class="notice ${message ? 'error' : ''}" role="status">${esc(message)}</div></form>
      <div class="login-note">Credentials are sent only to this Tariffia Pay API. Theme preference is the only dashboard setting stored locally.</div></section>
    </div>`;
  setTheme(localStorage.getItem('tariffia-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const notice = event.currentTarget.querySelector('.notice');
    credential = document.querySelector('#credential').value.trim();
    button.disabled = true;
    notice.className = 'notice'; notice.textContent = 'Checking access…';
    try {
      await api(admin ? '/v1/admin/dashboard/overview' : '/v1/dashboard/overview');
      renderShell();
      await openPage('overview');
    } catch (error) {
      credential = '';
      document.querySelector('#credential').value = '';
      notice.className = 'notice error'; notice.textContent = error.message;
      button.disabled = false;
    }
  });
}

function renderShell() {
  const items = navItems[role];
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">T</span><span>Tariffia <span style="font-weight:400">Pay</span></span></div>
      <div class="workspace-label">${role === 'admin' ? 'Platform' : 'Merchant account'}</div>
      <nav class="nav-list" aria-label="Dashboard sections">${items.map(([id, title], index) => `<button class="nav-button" data-page="${esc(id)}"><span class="nav-mark">${String(index + 1).padStart(2, '0')}</span>${esc(title)}</button>`).join('')}</nav>
      <div class="sidebar-bottom">Tariffia Pay<br>Non-custodial · Base USDC</div></aside>
    <section class="main-area"><header class="topbar"><div class="mobile-brand brand"><span class="brand-mark">T</span><span>Tariffia</span></div><div class="breadcrumb">${role === 'admin' ? 'Platform console' : 'Merchant console'} <span aria-hidden="true">/</span> <span id="crumb-current">Overview</span></div>
      <div class="top-actions"><span class="identity-chip">${role === 'admin' ? 'Administrator' : 'Merchant API session'}</span><button class="icon-button" data-theme-toggle type="button" aria-label="Switch theme">Dark</button><button class="button small" data-logout type="button">Sign out</button></div></header>
      <div id="page-content" class="content"><div class="empty-state">Loading dashboard…</div></div></section></div>`;
  setTheme(localStorage.getItem('tariffia-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.page)));
  document.querySelector('[data-theme-toggle]').addEventListener('click', () => setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.querySelector('[data-logout]').addEventListener('click', () => { credential = ''; showLogin(); });
}

function setPageTitle(id) {
  const title = id === 'overview' ? 'Overview' : id === 'health' ? 'System health' :
    id === 'api-usage' ? 'API usage' : id === 'api-keys' ? 'API keys' : id === 'webhooks' ? 'Webhooks' :
    id === 'transactions' ? 'Transactions' : id === 'settings' ? 'Settings' :
    (tables[role][id]?.title ?? (id === 'ai-models' ? 'Available AI models' : id));  document.querySelector('#crumb-current').textContent = title;
  document.querySelectorAll('[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === id));
  return title;
}

async function openPage(id) {
  currentPage = id;
  activeFilter = { page: 1, q: '', status: '' };
  const title = setPageTitle(id);
  const container = document.querySelector('#page-content');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (id === 'overview') await renderOverview(container);
    else if (id === 'health') await renderHealth(container);
    else if (role === 'merchant' && id === 'api-usage') await renderMerchantApiUsage(container);
    else if (role === 'merchant' && id === 'api-keys') await renderMerchantApiKeys(container);
    else if (role === 'merchant' && id === 'webhooks') await renderMerchantWebhooks(container);
    else if (role === 'merchant' && id === 'transactions') await renderMerchantTransactions(container);
    else if (role === 'merchant' && id === 'settings') await renderMerchantSettings(container);
    else if (role === 'merchant' && id === 'ai-models') await renderMerchantModels(container);
    else await renderCollectionPage(container, id, title);
  } catch (error) {
    if (!document.querySelector('#login-form')) container.innerHTML = `<section class="panel"><div class="notice error">${esc(error.message)}</div><button class="button" data-retry>Retry</button></section>`;
    container.querySelector('[data-retry]')?.addEventListener('click', () => openPage(id));
  }
}

async function renderOverview(container) {
  const [response, health, revenueResponse, historyResponse] = await Promise.all([
    api(role === 'admin' ? '/v1/admin/dashboard/overview' : '/v1/dashboard/overview'),
    fetch('/health', { cache: 'no-store' }).then((r) => r.ok ? r.json() : Promise.reject(new Error('Health check failed'))).catch(() => null),
    role === 'merchant' ? api('/v1/revenue/summary').catch(() => null) : Promise.resolve(null),
    role === 'merchant' ? api('/v1/revenue/history').catch(() => null) : Promise.resolve(null),
  ]);
  const data = response.overview ?? {};
  const revenue = revenueResponse?.revenue ?? null;
  const revenueHistory = (historyResponse?.history ?? []).slice(-14).reverse();
  const healthOk = health?.status === 'ok';
  const cards = role === 'admin'
    ? [
      stat('Merchants', data.merchants ?? 0, `${data.customers ?? 0} customers`),
      stat('Confirmed USDC', formatMoney(data.usdc_received, 'USD'), 'Verified on Base'),
      stat('AI revenue', formatMoney(data.ai_revenue_usd), `${data.ai_requests ?? 0} recorded requests`),
      stat('Provider cost', formatMoney(data.provider_cost_usd), `${data.failed_or_expired_payments ?? 0} failed / expired payments`),
      stat('AI profit', formatMoney(data.profit_usd), 'Recorded customer price minus provider cost'),
      stat('Pending payments', data.pending_payments ?? 0, `${data.orders ?? 0} total orders`),
      stat('Credit accounts', data.credit_accounts ?? 0, `${formatCredits(data.credit_balance_units)} credits held`),
      stat('Failed webhook deliveries', data.failed_webhook_deliveries ?? 0, healthOk ? 'API and database responding' : 'Check system health'),
    ]
    : [
      stat('Customers', data.customers ?? 0, 'Your account only'),
      stat('Orders', data.orders ?? 0, `${data.pending_payments ?? 0} payments pending`),
      stat('USDC received', formatMoney(data.usdc_received, 'USD'), 'Confirmed on Base'),
      stat('Credit balance', `${formatCredits(data.credit_balance_units)} credits`, `${data.credit_accounts ?? 0} customer accounts`),
      stat('AI requests', data.ai_requests ?? 0, 'Reported by your backend'),
      stat('AI customer charges', formatMoney(data.ai_usage_cost_usd), 'Internal credit usage'),
      stat('Failed / expired', data.failed_or_expired_payments ?? 0, 'Payments needing review'),
      stat('Failed webhooks', data.failed_webhook_deliveries ?? 0, healthOk ? 'API responding' : 'Check connection'),
    ];
  const revenuePanel = role === 'merchant' && revenue ? `<section class="panel"><div class="panel-head"><div><h2>Revenue</h2><p>Confirmed revenue and payment counts from your existing payment records. Read-only.</p></div></div>
    <div class="stats-grid">${stat('Confirmed revenue', formatMoney(revenue.totalConfirmed ?? 0, revenue.currency && revenue.currency !== 'MIXED' ? revenue.currency : 'USD'), `${revenue.confirmedPaymentCount ?? 0} confirmed payments`)}${stat('Confirmed', revenue.confirmedPaymentCount ?? 0, 'Payments confirmed')}${stat('Pending', revenue.pendingPaymentCount ?? 0, 'Awaiting confirmation')}${stat('Failed', revenue.failedPaymentCount ?? 0, 'Failed payments')}${stat('Expired', revenue.expiredPaymentCount ?? 0, 'Expired payments')}</div>
    ${revenueHistory.length ? `<div class="panel-head"><div><h2>Daily revenue history</h2><p>Confirmed revenue per UTC day (most recent first).</p></div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Currency</th><th>Confirmed amount</th><th>Payments</th></tr></thead><tbody>${revenueHistory.map((entry) => `<tr><td>${esc(entry.date)}</td><td>${esc(entry.currency)}</td><td>${esc(formatMoney(entry.confirmedAmount, entry.currency))}</td><td>${esc(entry.confirmedPaymentCount)}</td></tr>`).join('')}</tbody></table></div>` : ''}</section>` : '';
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">${role === 'admin' ? 'Operations' : 'Account activity'}</div><h1>${role === 'admin' ? 'Good overview.' : 'Your account at a glance.'}</h1><p>${role === 'admin' ? 'A live read of payments, stored credits, reseller economics and delivery health.' : 'A consolidated view of your payment rail and usage.'}</p></div><span class="health-badge ${healthOk ? '' : 'down'}">${healthOk ? 'API operational' : 'API unavailable'}</span></div>
    <div class="stats-grid">${cards.join('')}</div>${revenuePanel}<div class="overview-grid"><section class="panel"><div class="panel-head"><div><h2>${role === 'admin' ? 'Platform controls' : 'Next actions'}</h2><p>Current status from the shared Tariffia services.</p></div></div><div class="signal-list">
      ${signal('Payment engine', 'Base USDC verification and Payment Core', healthOk)}
      ${signal('Credit ledger', 'Existing internal balance and transaction records', true)}
      ${signal('AI metering', 'Model pricing and reported usage records', true)}
      ${signal('Webhook delivery', `${data.failed_webhook_deliveries ?? 0} failed deliveries to review`, Number(data.failed_webhook_deliveries ?? 0) === 0)}
    </div></section><section class="panel"><div class="panel-head"><div><h2>${role === 'admin' ? 'Workspace notes' : 'Account boundary'}</h2><p>Trust and accounting model</p></div></div><p style="color:var(--muted);font-size:13px;line-height:1.7;margin:0">${role === 'admin' ? 'All amounts are read from the existing payment, credit and AI usage records. This console does not initiate payment state changes.' : 'Every dashboard query is scoped to this merchant. USDC payments and internal credits remain separate; credit units cannot be withdrawn.'}</p></section></div>`;
}

function signal(title, subtitle, healthy) {
  return `<div class="signal"><span class="signal-dot ${healthy ? '' : 'warn'}"></span><div class="signal-copy"><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></div><span class="pill ${healthy ? 'good' : 'pending'}">${healthy ? 'Ready' : 'Review'}</span></div>`;
}

async function renderHealth(container) {
  let health;
  let error;
  try { health = await fetch('/health', { cache: 'no-store' }).then((response) => response.json()); }
  catch (caught) { error = caught.message; }
  const overview = await api('/v1/admin/dashboard/overview');
  const data = overview.overview ?? {};
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Platform status</div><h1>System health</h1><p>Basic API and database readiness, plus operational queue counts.</p></div><button class="button" data-refresh-health>Refresh</button></div>
    <div class="stats-grid">${stat('API', health?.status ?? 'Unavailable', error ?? 'GET /health')}${stat('Service', health?.service ?? '—', 'Application response')}${stat('Failed webhooks', data.failed_webhook_deliveries ?? 0, 'Delivery worker review queue')}${stat('Pending payments', data.pending_payments ?? 0, 'Payments under verification')}</div>
    <section class="panel"><div class="panel-head"><div><h2>Runtime response</h2><p>No private configuration is included in this status view.</p></div><span class="health-badge ${health?.status === 'ok' ? '' : 'down'}">${health?.status === 'ok' ? 'Healthy' : 'Unavailable'}</span></div><pre class="mono">${esc(JSON.stringify(health ?? { error: error ?? 'Health request failed' }, null, 2))}</pre></section>`;
  container.querySelector('[data-refresh-health]').addEventListener('click', () => openPage('health'));
}

async function renderMerchantModels(container) {
  const response = await api('/v1/ai/models');
  const models = response.models ?? [];
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">AI reseller catalog</div><h1>Available models</h1><p>Only enabled models and customer prices are shown. Usage is reported by your trusted backend.</p></div></div>
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Model</th><th>Pricing</th><th>Per request</th><th>Input / 1k</th><th>Output / 1k</th></tr></thead><tbody>${models.length ? models.map((model) => `<tr><td>${esc(model.providerName)}</td><td>${esc(model.name)} <span class="mono">${esc(model.model)}</span></td><td>${esc(model.pricingMode)}</td><td>${esc(formatMoney(model.pricePerRequestUsd))}</td><td>${esc(formatMoney(model.inputPricePer1kUsd))}</td><td>${esc(formatMoney(model.outputPricePer1kUsd))}</td></tr>`).join('') : '<tr><td colspan="6"><div class="empty-state">No AI models are currently enabled.</div></td></tr>'}</tbody></table></div></section>`;
}

async function loadCollectionRows(container, page, config) {
  const tableArea = container.querySelector('[data-table-area]');
  if (!tableArea) return;
  tableArea.innerHTML = '<div class="empty-state">Loading records…</div>';
  try {
    const query = new URLSearchParams({ page: String(activeFilter.page), limit: '25' });
    if (activeFilter.q) query.set('q', activeFilter.q);
    if (activeFilter.status) query.set('status', activeFilter.status);
    const endpoint = role === 'admin' ? `/v1/admin/dashboard/${config.endpoint}` : `/v1/dashboard/${config.endpoint}`;
    const data = await api(`${endpoint}?${query}`);
    const rows = data.items ?? [];
    tableArea.innerHTML = rows.length ? tableMarkup(rows, config) : '<div class="empty-state">No matching records.</div>';
    container.querySelector('[data-pager]').innerHTML = `<div class="table-footer"><span>Page ${data.page ?? activeFilter.page}${data.hasMore ? ' · more records available' : ''}</span><div class="pager"><button class="button small" data-prev ${activeFilter.page <= 1 ? 'disabled' : ''}>Previous</button><button class="button small" data-next ${data.hasMore ? '' : 'disabled'}>Next</button></div></div>`;
    container.querySelector('[data-prev]').addEventListener('click', () => { activeFilter.page--; loadCollectionRows(container, page, config); });
    container.querySelector('[data-next]').addEventListener('click', () => { activeFilter.page++; loadCollectionRows(container, page, config); });
    attachRowActions(container, page, config, rows);
  } catch (error) { tableArea.innerHTML = `<div class="empty-state notice error">${esc(error.message)}</div>`; }
}

function tableMarkup(rows, config) {
  const columns = [...config.columns];
  if (config.actions) columns.push(['__actions', 'Actions']);
  return `<div class="table-wrap"><table><thead><tr>${columns.map(([, title]) => `<th>${esc(title)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${key === '__actions' ? actionMarkup(config.actions, row) : cellValue(key, row[key], row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function cellValue(key, value, row) {
  if (key === 'enabled') return `<span class="pill ${value ? 'good' : 'bad'}">${value ? 'Enabled' : 'Disabled'}</span>`;
  if (key.toLowerCase().includes('status') || ['status', 'type'].includes(key)) return `<span class="pill ${statusTone(value)}">${esc(value)}</span>`;
  if (key === 'balanceUnits' || key === 'creditUnits' || key === 'balanceAfterUnits' || key === 'creditsDeductedUnits') return `<span class="mono">${esc(formatCredits(value))}</span>`;
  if (key === 'amount' || key === 'amountUsdc') return esc(formatMoney(value, key === 'amountUsdc' || row.currency === 'USDC' ? 'USDC' : row.currency === 'CREDITS' ? 'CREDITS' : 'USD'));
  if (['providerCostUsd', 'customerPriceUsd', 'profitUsd', 'pricePerRequestUsd', 'inputPricePer1kUsd', 'outputPricePer1kUsd', 'providerCostPerRequestUsd', 'customerPricePerRequestUsd', 'providerInputCostPer1kUsd', 'customerInputPricePer1kUsd', 'providerOutputCostPer1kUsd', 'customerOutputPricePer1kUsd'].includes(key)) return esc(value === null ? 'Markup-derived' : formatMoney(value));
  if (key.toLowerCase().includes('at') || key === 'expiresAt') return esc(formatDate(value));
  if (Array.isArray(value)) return esc(value.join(', '));
  if (key === 'transactionHash' && value) return `<span class="mono" title="${esc(value)}">${esc(value.slice(0, 13))}…${esc(value.slice(-8))}</span>`;
  if (key === 'paymentId' && value) return `<a class="inline-link" href="/p/${encodeURIComponent(value)}" target="_blank" rel="noreferrer">Open checkout</a>`;
  if (key === 'id' || key.endsWith('Id') || key === 'requestId') return `<span class="mono" title="${esc(value)}">${esc(String(value ?? '—').slice(0, 14))}${String(value ?? '').length > 14 ? '…' : ''}</span>`;
  return esc(value === null || value === undefined || value === '' ? '—' : value);
}

function statusTone(value) {
  const status = String(value ?? '').toUpperCase();
  if (['PAID', 'CONFIRMED', 'CREDITED', 'SUCCEEDED', 'ACTIVE', 'TOPUP', 'ENABLED'].includes(status)) return 'good';
  if (['FAILED', 'EXPIRED', 'CANCELLED', 'SUSPENDED'].includes(status)) return 'bad';
  return 'pending';
}

function actionMarkup(action, row) {
  if (action === 'provider') return `<button class="button small" data-toggle-config="provider" data-id="${esc(row.id)}">${row.enabled ? 'Disable' : 'Enable'}</button>`;
  if (action === 'model') return `<button class="button small" data-edit-model="${esc(row.id)}">Edit pricing</button> <button class="button small" data-toggle-config="model" data-id="${esc(row.id)}">${row.enabled ? 'Disable' : 'Enable'}</button>`;
  if (action === 'merchant-webhook') return `<button class="button small" data-toggle-webhook="${esc(row.id)}" data-enabled="${row.enabled}">${row.enabled ? 'Pause' : 'Resume'}</button> <button class="button small danger" data-delete-webhook="${esc(row.id)}">Delete</button>`;
  if (action === 'payment-link') return `<button class="button small" data-toggle-payment-link="${esc(row.paymentId)}" data-enabled="${row.enabled}">${row.enabled ? 'Disable' : 'Enable'}</button> <button class="button small danger" data-delete-payment-link="${esc(row.paymentId)}">Delete</button>`;
  if (action === 'order') return `<button class="button small" data-order-detail="${esc(row.id)}">Details</button>`;
  if (action === 'customer') return `<button class="button small" data-customer-detail="${esc(row.id)}">Details</button>`;
  if (action === 'admin-attempts' || action === 'merchant-attempts') return `<button class="button small" data-attempts="${esc(row.id)}" data-endpoint="${esc(row.endpointId ?? '')}">Attempts</button>`;
  return '';
}

function renderForm(target, kind) {
  if (!kind || !target) return;
  if (kind === 'customer') {
    target.innerHTML = `<section class="panel form-panel"><div class="panel-head"><div><h2>Add a customer</h2><p>Saved using the existing merchant customer API.</p></div></div><form data-form="customer" class="form-grid"><label class="field"><span>Name</span><input name="name" maxlength="120"></label><label class="field"><span>Email</span><input name="email" type="email" maxlength="254"></label><label class="field"><span>External ID</span><input name="externalId" maxlength="128"></label><div class="form-actions"><button class="button primary">Create customer</button><span class="notice" data-notice></span></div></form></section>`;
  } else if (kind === 'payment-link') {
    target.innerHTML = `<section class="panel form-panel"><div class="panel-head"><div><h2>Create a payment link</h2><p>Creates the order and USDC payment through Payment Core.</p></div></div><form data-form="payment-link" class="form-grid"><label class="field span-2"><span>Description</span><input name="description" maxlength="500" required></label><label class="field"><span>Amount (USDC)</span><input name="amount" inputmode="decimal" placeholder="12.50" required></label><label class="field"><span>Customer (optional)</span><select name="customerId"><option value="">No customer selected</option></select></label><div class="form-actions"><button class="button primary">Create link</button><span class="notice" data-notice></span></div></form></section>`;
    loadCustomerOptions(target.querySelector('[name="customerId"]'));
  } else if (kind === 'topup') {
    target.innerHTML = `<section class="panel form-panel"><div class="panel-head"><div><h2>Start a credit top-up</h2><p>Creates a USDC payment request; credits arrive only after server verification.</p></div></div><form data-form="topup" class="form-grid"><label class="field span-2"><span>Customer</span><select name="customerId" required><option value="">Select customer</option></select></label><label class="field"><span>Amount (USDC)</span><input name="amount" inputmode="decimal" placeholder="10.00" required></label><div class="form-actions"><button class="button primary">Create top-up payment</button><span class="notice" data-notice></span></div></form></section>`;
    loadCustomerOptions(target.querySelector('[name="customerId"]'));
  } else if (kind === 'webhook') {
    target.innerHTML = `<section class="panel form-panel"><div class="panel-head"><div><h2>Add a webhook destination</h2><p>The signing secret is encrypted by the existing API and never shown again.</p></div></div><form data-form="webhook" class="form-grid"><label class="field"><span>Name</span><input name="name" maxlength="100" required></label><label class="field span-2"><span>HTTPS endpoint</span><input name="url" type="url" placeholder="https://merchant.example/hooks" required></label><label class="field span-2"><span>Signing secret</span><input name="secret" type="password" minlength="32" maxlength="256" autocomplete="new-password" required></label><label class="field"><span>Events (comma-separated)</span><input name="events" value="payment.confirmed,order.paid" required></label><div class="form-actions"><button class="button primary">Save endpoint</button><span class="notice" data-notice></span></div></form></section>`;
  }
  target.querySelector('form')?.addEventListener('submit', submitForm);
}

async function loadCustomerOptions(select) {
  try {
    const response = await api('/v1/dashboard/customers?limit=100');
    for (const customer of response.items ?? []) {
      const option = document.createElement('option');
      option.value = customer.id; option.textContent = `${customer.name || customer.email || customer.externalId || customer.id}`;
      select.append(option);
    }
  } catch { /* The form remains usable once customer records are available. */ }
}

async function submitForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const notice = form.querySelector('[data-notice]');
  const values = Object.fromEntries(new FormData(form).entries());
  button.disabled = true; notice.className = 'notice'; notice.textContent = 'Saving…';
  try {
    if (form.dataset.form === 'customer') {
      const customer = Object.fromEntries(['name', 'email', 'externalId'].filter((key) => values[key]?.trim()).map((key) => [key, values[key].trim()]));
      if (!customer.externalId && !customer.email) throw new Error('Provide an email or external ID.');
      await api('/v1/customers', { method: 'POST', body: JSON.stringify({ ...customer, metadata: {} }) });
      notify('Customer created.');
    } else if (form.dataset.form === 'payment-link') {
      const body = { description: values.description, amount: values.amount, currency: 'USDC', metadata: {} };
      if (values.customerId) body.customerId = values.customerId;
      const result = await api('/v1/payment-links', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
      const checkout = result.checkoutUrl ?? result.payment?.checkoutUrl ?? (result.payment?.id ? `${location.origin}/p/${result.payment.id}` : '');
      notice.className = 'notice success';
      notice.innerHTML = checkout ? `Link ready: <a class="inline-link" href="${esc(checkout)}" target="_blank" rel="noreferrer">Open checkout</a>` : 'Payment link created.';
      notify('Payment link created through Payment Core.');
    } else if (form.dataset.form === 'topup') {
      const result = await api('/v1/credits/topups', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ customerId: values.customerId, amount: values.amount }) });
      const checkout = result.checkoutUrl ?? result.payment?.checkoutUrl ?? (result.payment?.id ? `${location.origin}/p/${result.payment.id}` : '');
      notice.className = 'notice success';
      notice.innerHTML = checkout ? `Payment request ready: <a class="inline-link" href="${esc(checkout)}" target="_blank" rel="noreferrer">Open checkout</a>` : 'Top-up payment request created.';
      notify('Credit top-up payment request created.');
    } else if (form.dataset.form === 'webhook') {
      const events = values.events.split(',').map((item) => item.trim()).filter(Boolean);
      await api('/v1/webhooks', { method: 'POST', body: JSON.stringify({ name: values.name, url: values.url, secret: values.secret, events }) });
      form.reset();
      notify('Endpoint saved. The signing secret was submitted once and is not displayed.');
    }
    if (form.dataset.form === 'customer') form.reset();
    if (form.dataset.form !== 'payment-link' && form.dataset.form !== 'topup') notice.textContent = 'Saved.';
    loadCollectionRows(document.querySelector('#page-content'), currentPage, tables[role][currentPage]);
  } catch (error) {
    notice.className = 'notice error'; notice.textContent = error.message;
  } finally { button.disabled = false; }
}

function notify(message) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message;
  document.body.append(toast); setTimeout(() => toast.remove(), 4200);
}

function attachRowActions(container, page, config, rows) {
  container.querySelectorAll('[data-edit-model]').forEach((button) => button.addEventListener('click', async () => {
    const row = rows.find((item) => item.id === button.dataset.editModel);
    if (!row) return;
    button.disabled = true;
    try {
      const slot = container.querySelector('#page-form');
      await renderAdminAiForms(slot, 'ai-models');
      const form = slot.querySelector('form');
      form.dataset.modelId = row.id;
      for (const [name, value] of Object.entries({
        providerId: row.providerId, slug: row.slug, name: row.name, pricingMode: row.pricingMode,
        providerCostPerRequestUsd: row.providerCostPerRequestUsd,
        customerPricePerRequestUsd: row.customerPricePerRequestUsd ?? '',
        providerInputCostPer1kUsd: row.providerInputCostPer1kUsd,
        customerInputPricePer1kUsd: row.customerInputPricePer1kUsd ?? '',
        providerOutputCostPer1kUsd: row.providerOutputCostPer1kUsd,
        customerOutputPricePer1kUsd: row.customerOutputPricePer1kUsd ?? '',
        markupBps: row.markupBps, enabled: String(row.enabled),
      })) {
        const field = form.elements.namedItem(name);
        if (field) field.value = value;
      }
      form.elements.namedItem('providerId').disabled = true;
      form.querySelector('h2').textContent = 'Edit model pricing';
      form.querySelector('button').textContent = 'Update pricing';
      slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { notify(error.message); }
  }));
  container.querySelectorAll('[data-toggle-config]').forEach((button) => button.addEventListener('click', async () => {
    const row = rows.find((item) => item.id === button.dataset.id);
    if (!row) return;
    button.disabled = true;
    try {
      if (button.dataset.toggleConfig === 'provider') await api(`/v1/admin/ai/providers/${row.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !row.enabled }) });
      else {
        const payload = {
          slug: row.slug, name: row.name, enabled: !row.enabled, pricingMode: row.pricingMode,
          providerCostPerRequestUsd: row.providerCostPerRequestUsd,
          customerPricePerRequestUsd: row.customerPricePerRequestUsd,
          providerInputCostPer1kUsd: row.providerInputCostPer1kUsd,
          customerInputPricePer1kUsd: row.customerInputPricePer1kUsd,
          providerOutputCostPer1kUsd: row.providerOutputCostPer1kUsd,
          customerOutputPricePer1kUsd: row.customerOutputPricePer1kUsd, markupBps: row.markupBps,
        };
        await api(`/v1/admin/ai/models/${row.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      notify('Configuration updated.'); loadCollectionRows(container, page, config);
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
  container.querySelectorAll('[data-toggle-webhook]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/v1/webhooks/${button.dataset.toggleWebhook}`, { method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' }) });
      notify('Webhook delivery setting updated.'); loadCollectionRows(container, page, config);
    } catch (error) { notify(error.message); }
  }));
  container.querySelectorAll('[data-delete-webhook]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Delete this webhook endpoint? Queued deliveries will be cancelled.')) return;
    try {
      await api(`/v1/webhooks/${button.dataset.deleteWebhook}`, { method: 'DELETE' });
      notify('Webhook endpoint deleted.'); loadCollectionRows(container, page, config);
    } catch (error) { notify(error.message); }
  }));
  container.querySelectorAll('[data-attempts]').forEach((button) => button.addEventListener('click', () => showAttempts(button.dataset.attempts, button.dataset.endpoint)));
  container.querySelectorAll('[data-toggle-payment-link]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/v1/payment-links/${encodeURIComponent(button.dataset.togglePaymentLink)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' }),
      });
      notify('Payment link updated.');
      loadCollectionRows(container, page, config);
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
  container.querySelectorAll('[data-delete-payment-link]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Delete this payment link? Its checkout page will stop working.')) return;
    button.disabled = true;
    try {
      await api(`/v1/payment-links/${encodeURIComponent(button.dataset.deletePaymentLink)}`, { method: 'DELETE' });
      notify('Payment link deleted.');
      loadCollectionRows(container, page, config);
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
  container.querySelectorAll('[data-order-detail]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/v1/orders/${encodeURIComponent(button.dataset.orderDetail)}`);
      const order = result.order ?? {};
      const fields = [
        ['Order ID', order.id], ['Reference', order.reference ?? '—'], ['Description', order.description],
        ['Amount', `${order.amount} ${order.currency}`], ['Order status', order.status],
        ['Payment status', order.paymentStatus], ['Payment ID', order.paymentId ?? '—'],
        ['Network', order.network ?? '—'], ['Transaction', order.transactionId ?? '—'],
        ['Expires', order.expiresAt ? formatDate(order.expiresAt) : '—'],
        ['Created', formatDate(order.createdAt)], ['Updated', formatDate(order.updatedAt)],
      ];
      showModal('Order details', `<div class="table-wrap"><table><tbody>${fields.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value ?? '—')}</td></tr>`).join('')}</tbody></table></div>`, 'Order');
    } catch (error) { notify(error.message); } finally { button.disabled = false; }
  }));
  container.querySelectorAll('[data-customer-detail]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/v1/customers/${encodeURIComponent(button.dataset.customerDetail)}`);
      const customer = result.customer ?? {};
      const fields = [
        ['Customer ID', customer.id], ['Name', customer.name ?? '—'], ['Email', customer.email ?? '—'],
        ['External ID', customer.externalId ?? '—'], ['Orders', customer.orderCount ?? 0],
        ['Payments', customer.paymentCount ?? 0], ['Created', formatDate(customer.createdAt)],
      ];
      showModal('Customer details', `<div class="table-wrap"><table><tbody>${fields.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value ?? '—')}</td></tr>`).join('')}</tbody></table></div>`, 'Customer');
    } catch (error) { notify(error.message); } finally { button.disabled = false; }
  }));
}

async function showAttempts(deliveryId, endpointId) {
  try {
    const path = role === 'admin'
      ? `/v1/admin/webhook-deliveries/${encodeURIComponent(deliveryId)}/attempts`
      : `/v1/webhooks/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/attempts`;
    const result = await api(path);
    const attempts = result.attempts ?? [];
    const html = attempts.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>HTTP</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead><tbody>${attempts.map((item) => `<tr><td>${esc(item.attemptNumber)}</td><td>${esc(item.httpStatus ?? '—')}</td><td>${esc(formatDate(item.startedAt))}</td><td>${esc(formatDate(item.finishedAt))}</td><td>${esc(item.error ?? '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No attempts recorded.</div>';
    showModal('Delivery attempts', html, 'Webhook delivery');
  } catch (error) { notify(error.message); }
}

function showModal(title, content, eyebrow = 'Details') {
  document.querySelector('.modal-backdrop')?.remove();
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><button class="button small modal-close" type="button">Close</button><div class="panel-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2></div></div>${content}</section>`;
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop || event.target.closest('.modal-close')) backdrop.remove(); });
  document.body.append(backdrop);
}

async function renderAdminAiForms(target, page) {
  if (role !== 'admin') return;
  if (page === 'ai-providers') {
    target.innerHTML = `<section class="panel form-panel"><div class="panel-head"><div><h2>Register provider label</h2><p>Provider credentials are read from the server environment and are never stored or shown here.</p></div></div><form data-form="provider" class="form-grid"><label class="field"><span>Slug</span><input name="slug" pattern="[a-z0-9][a-z0-9_-]{0,63}" required></label><label class="field span-2"><span>Display name</span><input name="name" maxlength="100" required></label><label class="field"><span>Integration</span><select name="integration"><option value="openai-compatible">OpenAI-compatible</option></select></label><label class="field"><span>Provider timeout (ms)</span><input name="timeoutMs" type="number" min="1000" max="120000" placeholder="Environment default"></label><div class="form-actions"><button class="button primary">Add provider</button><span class="notice" data-notice></span></div></form></section>`;
  } else if (page === 'ai-models') {
    const providers = await api('/v1/admin/ai/providers');
    target.innerHTML = `<section class="panel form-panel"><div class="panel-head"><div><h2>Add a model and price</h2><p>Prices are USD; blank customer component prices use the markup basis points.</p></div></div>
      <form data-form="model" class="form-grid"><label class="field"><span>Provider</span><select name="providerId" required>${(providers.providers ?? []).map((provider) => `<option value="${esc(provider.id)}">${esc(provider.name)} · ${esc(provider.slug)}</option>`).join('')}</select></label>
      <label class="field"><span>Model slug</span><input name="slug" required pattern="[a-z0-9][a-z0-9_-]{0,63}"></label><label class="field"><span>Display name</span><input name="name" required maxlength="120"></label>
      <label class="field"><span>Pricing mode</span><select name="pricingMode"><option>PER_1K_TOKENS</option><option>PER_REQUEST</option><option>PER_REQUEST_AND_TOKENS</option></select></label>
      <label class="field"><span>Provider request USD</span><input name="providerCostPerRequestUsd" value="0" inputmode="decimal"></label><label class="field"><span>Customer request USD (optional)</span><input name="customerPricePerRequestUsd" placeholder="Markup-derived" inputmode="decimal"></label>
      <label class="field"><span>Provider input / 1k USD</span><input name="providerInputCostPer1kUsd" value="0" inputmode="decimal"></label><label class="field"><span>Customer input / 1k USD</span><input name="customerInputPricePer1kUsd" placeholder="Markup-derived" inputmode="decimal"></label>
      <label class="field"><span>Provider output / 1k USD</span><input name="providerOutputCostPer1kUsd" value="0" inputmode="decimal"></label>      <label class="field"><span>Customer output / 1k USD</span><input name="customerOutputPricePer1kUsd" placeholder="Markup-derived" inputmode="decimal"></label>
      <label class="field"><span>Provider model name</span><input name="providerModel" placeholder="Defaults to the model slug" maxlength="120"></label>
      <label class="field"><span>Max output tokens</span><input name="maxOutputTokens" type="number" min="1" max="4096" value="512"></label>
      <label class="field"><span>Markup (basis points)</span><input name="markupBps" type="number" min="0" max="100000" value="0"></label><label class="field"><span>Enabled</span><select name="enabled"><option value="false">No</option><option value="true">Yes</option></select></label>
      <div class="form-actions"><button class="button primary" ${providers.providers?.length ? '' : 'disabled'}>Save model pricing</button><span class="notice" data-notice>${providers.providers?.length ? '' : 'Create a provider before adding models.'}</span></div></form></section>`;
  }
  target.querySelector('form')?.addEventListener('submit', submitAdminAiForm);
}

async function submitAdminAiForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const notice = form.querySelector('[data-notice]');
  const values = Object.fromEntries(new FormData(form).entries());
  button.disabled = true; notice.className = 'notice'; notice.textContent = 'Saving…';
  try {
    if (form.dataset.form === 'provider') {
      await api('/v1/admin/ai/providers', {
        method: 'POST',
        body: JSON.stringify({
          slug: values.slug, name: values.name, enabled: true,
          integration: values.integration,
          ...(values.timeoutMs ? { timeoutMs: Number(values.timeoutMs) } : {}),
        }),
      });
    } else {
      const body = {
        slug: values.slug, name: values.name, enabled: values.enabled === 'true', pricingMode: values.pricingMode,
        providerCostPerRequestUsd: values.providerCostPerRequestUsd || '0',
        customerPricePerRequestUsd: values.customerPricePerRequestUsd || null,
        providerInputCostPer1kUsd: values.providerInputCostPer1kUsd || '0',
        customerInputPricePer1kUsd: values.customerInputPricePer1kUsd || null,
        providerOutputCostPer1kUsd: values.providerOutputCostPer1kUsd || '0',
        customerOutputPricePer1kUsd: values.customerOutputPricePer1kUsd || null,
        markupBps: Number(values.markupBps || 0),
        providerModel: values.providerModel || undefined,
        maxOutputTokens: Number(values.maxOutputTokens || 512),
      };
      if (form.dataset.modelId) {
        await api(`/v1/admin/ai/models/${form.dataset.modelId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api(`/v1/admin/ai/providers/${values.providerId}/models`, { method: 'POST', body: JSON.stringify(body) });
      }
    }
    form.reset();
    notify('Configuration saved.');
    await openPage(currentPage);
  } catch (error) { notice.className = 'notice error'; notice.textContent = error.message; button.disabled = false; }
}

async function renderCollectionPage(container, page, title) {
  const config = tables[role][page];
  if (!config) throw new Error('This section is not available.');
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">${role === 'admin' ? 'Platform data' : 'Merchant data'}</div><h1>${esc(title)}</h1><p>${esc(config.description)}</p></div></div>
    <div id="page-form"></div><section class="panel"><div class="toolbar"><label class="field search-field"><span>Search</span><input type="search" data-search placeholder="Search this collection" value="${esc(activeFilter.q)}"></label>
      ${config.filter ? `<label class="field filter-field"><span>Status / type</span><select data-status><option value="">All</option>${config.filter.map((option) => `<option value="${esc(option)}">${esc(option)}</option>`).join('')}</select></label>` : ''}
      <button class="button" data-reload>Refresh</button></div><div data-table-area class="empty-state">Loading records…</div><div data-pager></div></section>`;
  const formSlot = container.querySelector('#page-form');
  if (role === 'admin' && ['ai-providers', 'ai-models'].includes(page)) await renderAdminAiForms(formSlot, page);
  else renderForm(formSlot, config.form);
  const search = container.querySelector('[data-search]');
  search.addEventListener('input', () => {
    activeFilter.q = search.value; activeFilter.page = 1;
    clearTimeout(searchTimer); searchTimer = setTimeout(() => loadCollectionRows(container, page, config), 230);
  });
  container.querySelector('[data-status]')?.addEventListener('change', (event) => { activeFilter.status = event.target.value; activeFilter.page = 1; loadCollectionRows(container, page, config); });
  container.querySelector('[data-reload]').addEventListener('click', () => loadCollectionRows(container, page, config));
  await loadCollectionRows(container, page, config);
}

const themePreference = localStorage.getItem('tariffia-theme');
setTheme(themePreference ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
showLogin();
