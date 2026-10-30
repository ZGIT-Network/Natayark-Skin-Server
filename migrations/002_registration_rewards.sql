-- Idempotency ledger for the migrated share-registration-link plugin.
CREATE TABLE IF NOT EXISTS mcn_registration_rewards (
  uid INT UNSIGNED NOT NULL PRIMARY KEY,
  code_id INT UNSIGNED NOT NULL,
  sharer INT NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
