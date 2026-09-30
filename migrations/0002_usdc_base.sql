ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_base_units numeric(78, 0),
  ADD COLUMN IF NOT EXISTS adapter_data jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE payments
   SET amount_base_units = (amount * 1000000)::numeric(78, 0)
 WHERE amount_base_units IS NULL;

UPDATE payments
   SET token_address = lower('0x833589fCD6eDb6E08f4c7C32d4F71b54bdA02913')
 WHERE adapter = 'usdc' AND network = 'base' AND token_address IS NULL;

UPDATE payments
   SET adapter_data = jsonb_build_object(
     'chainId', 8453,
     'decimals', 6,
     'amountBaseUnits', amount_base_units::text
   )
 WHERE adapter = 'usdc' AND network = 'base' AND adapter_data = '{}'::jsonb;

ALTER TABLE payments ALTER COLUMN amount_base_units SET NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payments_amount_base_units_positive CHECK (amount_base_units > 0);

CREATE TABLE IF NOT EXISTS payment_scan_cursors (
  network text PRIMARY KEY,
  last_scanned_block bigint NOT NULL CHECK (last_scanned_block >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
