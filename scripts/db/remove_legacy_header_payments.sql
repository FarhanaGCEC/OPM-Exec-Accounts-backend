-- Remove duplicate legacy / header-total rows from card statement paid/epp breakdowns.
-- Prefer running: npm run db:clean-legacy-payments
-- (Node cleanup handles timezone + header-total duplicates; this file is a minimal SQL fallback.)

DELETE FROM card_statement_payments WHERE note = 'legacy:header';
DELETE FROM card_statement_epp_payments WHERE note = 'legacy:header';
