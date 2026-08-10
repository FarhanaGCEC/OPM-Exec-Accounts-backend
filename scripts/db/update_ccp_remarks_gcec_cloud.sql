-- Normalize credit_card_payments remarks → "GCEC Cloud"
-- Run manually on the target MySQL database (local / DigitalOcean / cPanel).

-- 1) Old default text
UPDATE credit_card_payments
SET remarks = 'GCEC Cloud',
    updated_at = CURRENT_TIMESTAMP
WHERE TRIM(remarks) = 'Paid from GCEC Cloud Acc';

-- 2) Paid rows with empty / null remarks (e.g. statement partial creates before default)
UPDATE credit_card_payments
SET remarks = 'GCEC Cloud',
    updated_at = CURRENT_TIMESTAMP
WHERE (payment_type IS NULL OR LOWER(TRIM(payment_type)) = 'paid')
  AND (remarks IS NULL OR TRIM(remarks) = '');

-- Optional check after update:
-- SELECT id, customer_name, amount, remarks FROM credit_card_payments WHERE remarks = 'GCEC Cloud';
-- SELECT id, remarks FROM credit_card_payments WHERE remarks IS NULL OR TRIM(remarks) = '';
-- SELECT id, remarks FROM credit_card_payments WHERE remarks LIKE '%Paid from GCEC Cloud Acc%';
