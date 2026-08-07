-- Replace credit_card_payments remarks:
-- "Paid from GCEC Cloud Acc" → "GCEC Cloud"
-- Run manually on the target MySQL database (local / DigitalOcean / cPanel).

UPDATE credit_card_payments
SET remarks = 'GCEC Cloud',
    updated_at = CURRENT_TIMESTAMP
WHERE TRIM(remarks) = 'Paid from GCEC Cloud Acc';

-- Optional check after update:
-- SELECT id, remarks FROM credit_card_payments WHERE remarks = 'GCEC Cloud';
-- SELECT id, remarks FROM credit_card_payments WHERE remarks LIKE '%Paid from GCEC Cloud Acc%';
