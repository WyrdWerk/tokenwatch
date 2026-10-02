-- Preserve the billing rule alongside raw tariffs so history uses the rule
-- captured that day, not a later provider policy. NULL keeps legacy behavior.
ALTER TABLE price_snapshot ADD COLUMN input_billing TEXT
  CHECK (input_billing IS NULL OR input_billing = 'cache_write');
