-- GCEC Account Backend schema + seed for cPanel/phpMyAdmin import
-- Notes:
-- 1) In cPanel, first create a database and DB user, then assign all privileges.
-- 2) Select that database in phpMyAdmin and import this file.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payables_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS receivables_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credit_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  issuing_bank VARCHAR(255) NOT NULL,
  card_holder VARCHAR(255) NOT NULL,
  card_number VARCHAR(50) NOT NULL,
  expiry VARCHAR(10) NOT NULL,
  cvv VARCHAR(10),
  amount_limit DECIMAL(15, 2),
  is_system TINYINT(1) DEFAULT 0,
  is_default TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_credit_cards_is_system (is_system)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credit_cards_new (
  id CHAR(36) PRIMARY KEY,
  issuing_bank VARCHAR(255) NOT NULL,
  card_holder VARCHAR(255) NOT NULL,
  card_number VARCHAR(50) NOT NULL,
  expiry_date VARCHAR(10) NOT NULL,
  credit_limit DECIMAL(15, 2),
  billing_cycle_days INT NOT NULL DEFAULT 25,
  statement_day INT NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 999,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_credit_cards_new_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date DATE NOT NULL,
  type VARCHAR(10) NOT NULL,
  category_id INT,
  category_type VARCHAR(20),
  payment_type VARCHAR(50) NOT NULL,
  cheque_number VARCHAR(50),
  amount DECIMAL(15, 2) NOT NULL,
  balance DECIMAL(15, 2) NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  remarks TEXT,
  KEY idx_transactions_date (date),
  CONSTRAINT fk_transactions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS post_dated_cheques (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cheque_date DATE NOT NULL,
  cheque_number VARCHAR(100) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  cheque_type VARCHAR(50) NOT NULL DEFAULT 'Payment Cheque',
  pdc_type VARCHAR(50) NOT NULL,
  description TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pdc_cheque_date (cheque_date),
  CONSTRAINT fk_pdc_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credit_card_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payment_date DATE NOT NULL,
  credit_card_id CHAR(36),
  customer_name VARCHAR(255),
  payment_method VARCHAR(50) NOT NULL DEFAULT 'Credit Card',
  amount DECIMAL(15, 2) NOT NULL,
  remarks TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cc_payment_date (payment_date),
  CONSTRAINT fk_cc_payments_card FOREIGN KEY (credit_card_id) REFERENCES credit_cards_new(id) ON DELETE CASCADE,
  CONSTRAINT fk_cc_payments_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credit_card_statements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  card_id INT NOT NULL,
  statement_month INT NOT NULL,
  statement_year INT NOT NULL,
  statement_date DATE NOT NULL,
  due_date DATE NOT NULL,
  due_month VARCHAR(50),
  total_payment_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
  paid DECIMAL(15, 2) NOT NULL DEFAULT 0,
  epp DECIMAL(15, 2) NOT NULL DEFAULT 0,
  amount_pending DECIMAL(15, 2) NOT NULL DEFAULT 0,
  status VARCHAR(10) NOT NULL DEFAULT 'DUE',
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_card_month_year (card_id, statement_month, statement_year),
  KEY idx_cc_statements_card_month_year (card_id, statement_month, statement_year),
  KEY idx_cc_statements_month_year (statement_month, statement_year),
  CONSTRAINT fk_cc_statements_card FOREIGN KEY (card_id) REFERENCES credit_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS card_statements (
  id CHAR(36) PRIMARY KEY,
  credit_card_id CHAR(36) NOT NULL,
  statement_month VARCHAR(7) NOT NULL,
  statement_date DATE NOT NULL,
  due_date DATE NOT NULL,
  days INT NOT NULL,
  due_month VARCHAR(50),
  total_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  pending_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  epp_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
  balance_transfer DECIMAL(15, 2) NOT NULL DEFAULT 0,
  payment_status VARCHAR(10) NOT NULL DEFAULT 'PARTIAL',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_card_month (credit_card_id, statement_month),
  KEY idx_card_statements_month (statement_month),
  KEY idx_card_statements_card_month (credit_card_id, statement_month),
  KEY idx_card_statements_status (payment_status),
  CONSTRAINT fk_card_statements_card FOREIGN KEY (credit_card_id) REFERENCES credit_cards_new(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Compatibility for older MySQL versions (no DEFAULT(UUID()) support)
DELIMITER $$
DROP TRIGGER IF EXISTS trg_credit_cards_new_uuid$$
CREATE TRIGGER trg_credit_cards_new_uuid
BEFORE INSERT ON credit_cards_new
FOR EACH ROW
BEGIN
  IF NEW.id IS NULL OR NEW.id = '' THEN
    SET NEW.id = UUID();
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_card_statements_uuid$$
CREATE TRIGGER trg_card_statements_uuid
BEFORE INSERT ON card_statements
FOR EACH ROW
BEGIN
  IF NEW.id IS NULL OR NEW.id = '' THEN
    SET NEW.id = UUID();
  END IF;
END$$
DELIMITER ;

CREATE TABLE IF NOT EXISTS purchase_bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_date DATE NOT NULL,
  invoice_number VARCHAR(255),
  vendor_name VARCHAR(255),
  bill_number VARCHAR(255),
  payment_method VARCHAR(50) NOT NULL DEFAULT 'Credit Card',
  amount DECIMAL(15, 2) NOT NULL,
  description TEXT,
  payment_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchase_bills_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usd_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_number VARCHAR(50),
  date DATE NOT NULL,
  description VARCHAR(255) NOT NULL,
  details VARCHAR(255),
  debit DECIMAL(15, 2) DEFAULT 0,
  bank_charges DECIMAL(15, 2) DEFAULT 0,
  credit DECIMAL(15, 2) DEFAULT 0,
  balance DECIMAL(15, 2) NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_usd_transactions_date (date),
  KEY idx_usd_transactions_account (account_number),
  CONSTRAINT fk_usd_transactions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gbp_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_number VARCHAR(50),
  date DATE NOT NULL,
  description VARCHAR(255) NOT NULL,
  details VARCHAR(255),
  debit DECIMAL(15, 2) DEFAULT 0,
  bank_charges DECIMAL(15, 2) DEFAULT 0,
  credit DECIMAL(15, 2) DEFAULT 0,
  balance DECIMAL(15, 2) NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_gbp_transactions_date (date),
  KEY idx_gbp_transactions_account (account_number),
  CONSTRAINT fk_gbp_transactions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS emirates_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_number VARCHAR(50),
  date DATE NOT NULL,
  description VARCHAR(255) NOT NULL,
  details VARCHAR(255),
  currency VARCHAR(3) NOT NULL DEFAULT 'AED',
  debit DECIMAL(15, 2) DEFAULT 0,
  bank_charges DECIMAL(15, 2) DEFAULT 0,
  credit DECIMAL(15, 2) DEFAULT 0,
  balance DECIMAL(15, 2) NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_emirates_transactions_date (date),
  KEY idx_emirates_transactions_account (account_number),
  KEY idx_emirates_transactions_currency (currency),
  CONSTRAINT fk_emirates_transactions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed admin user (password is bcrypt hash for: admin123)
INSERT INTO users (username, password)
SELECT 'admin', '$2a$10$Lo.cUiHdEmGn0nU6AMN7oOd8UJNBoqx015NlK6paxlSWGd6.YtuXu'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin');

-- Seed categories
INSERT IGNORE INTO payables_categories (name) VALUES
('Office Rent'),
('Utilities'),
('Salaries'),
('Supplier Payment'),
('Transport'),
('Misc Expense');

INSERT IGNORE INTO receivables_categories (name) VALUES
('Customer Payment'),
('Sales'),
('Refund'),
('Other Income');

-- Seed credit_cards_new only (card master). No rows in card_statements / credit_card_statements.
INSERT INTO credit_cards_new (id, issuing_bank, card_holder, card_number, expiry_date, billing_cycle_days, statement_day, display_order, is_active)
SELECT v.id, v.issuing_bank, v.card_holder, v.card_number, v.expiry_date, v.billing_cycle_days, v.statement_day, v.display_order, v.is_active
FROM (
  SELECT UUID() AS id, 'Deem Finance' AS issuing_bank, 'Suleman' AS card_holder, '5313 9800 0593 7036' AS card_number, 'Feb-28' AS expiry_date, 21 AS billing_cycle_days, 2 AS statement_day, 1 AS display_order, 1 AS is_active UNION ALL
  SELECT UUID(), 'Emirates NBD Etihad', 'Suleman', '4033 3700 5851 2427', 'Dec-29', 25, 2, 2, 1 UNION ALL
  SELECT UUID(), 'Mashreq Smart Saver', 'Farhana', '4198 6424 7010 9201', 'Dec-28', 27, 2, 3, 1 UNION ALL
  SELECT UUID(), 'CBD Smiles', 'Farhana', '4451 3530 1729 0890', 'May-28', 22, 8, 4, 1 UNION ALL
  SELECT UUID(), 'Mashreq Solitaire', 'Suleman', '4198 6924 7111 9303', 'Dec-26', 27, 8, 5, 1 UNION ALL
  SELECT UUID(), 'Sunil ENBD', 'Sunil', '5127 1710 0443 0639', 'Nov-28', 26, 9, 6, 1 UNION ALL
  SELECT UUID(), 'EIB Skywards Infinite', 'Farhana', '4421 0985 7539 4017', 'Dec-30', 26, 9, 7, 1 UNION ALL
  SELECT UUID(), 'ADCB Lulu Card', 'Farhana', '5193 0515 9143 9210', 'Nov-29', 25, 10, 8, 1 UNION ALL
  SELECT UUID(), 'EIB Black Card', 'Suleman', '4189 6405 0093 0001', 'Jan-31', 25, 10, 9, 1 UNION ALL
  SELECT UUID(), 'EIB RTA Card', 'Suleman', '4578 2888 1556 6166', 'Jun-26', 25, 10, 10, 1 UNION ALL
  SELECT UUID(), 'FAB World', 'Suleman', '5492 8403 0052 7218', 'Sep-30', 25, 11, 11, 1 UNION ALL
  SELECT UUID(), 'FAB Blue', 'Suleman', '4921 8600 4361 8557', 'Mar-28', 25, 11, 12, 1 UNION ALL
  SELECT UUID(), 'ADCB - Primary', 'Suleman', '5429 3374 1496 6216', 'Mar-27', 25, 15, 13, 1 UNION ALL
  SELECT UUID(), 'SCB Manhattan', 'Farhana', '4703 4710 0058 4834', 'Apr-27', 25, 19, 14, 1 UNION ALL
  SELECT UUID(), 'SCB Infinite', 'Suleman', '4444 4710 0068 5148', 'Jun-26', 25, 19, 15, 1 UNION ALL
  SELECT UUID(), 'FAB World', 'Farhana', '5492 8403 1836 5528', 'May-30', 25, 25, 16, 1 UNION ALL
  SELECT UUID(), 'SCB Manhattan', 'Suleman', '4703 4710 0005 8821', 'Sep-28', 25, 26, 17, 1
) AS v
WHERE NOT EXISTS (SELECT 1 FROM credit_cards_new LIMIT 1);

SET FOREIGN_KEY_CHECKS = 1;
