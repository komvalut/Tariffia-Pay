ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check CHECK (event_type IN (
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired',
  'order.paid', 'credit.topup', 'credit.deducted', 'ai.usage.recorded', 'invoice.issued', 'receipt.issued'
));

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY,
  invoice_number text NOT NULL UNIQUE,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid REFERENCES customers(id),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  amount numeric(36, 6) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  payment_method text NOT NULL,
  network text NOT NULL,
  payment_status text NOT NULL CHECK (payment_status = 'CONFIRMED'),
  transaction_id text NOT NULL,
  paid_at timestamptz NOT NULL,
  merchant_name text NOT NULL,
  merchant_email text NOT NULL,
  customer_name text,
  customer_email text,
  order_reference text,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY,
  public_id varchar(43) NOT NULL UNIQUE,
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_merchant_created_idx ON invoices (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_customer_created_idx ON invoices (customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipts_merchant_issued_idx ON receipts (merchant_id, issued_at DESC);
