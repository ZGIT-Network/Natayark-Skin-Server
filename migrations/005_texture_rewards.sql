-- Separate ledgers retain content claims after a material is deleted.
CREATE TABLE IF NOT EXISTS mcn_texture_rewards (
  user_id int NOT NULL,
  fingerprint char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount int NOT NULL DEFAULT 0,
  claimed_at datetime NOT NULL,
  PRIMARY KEY (user_id, fingerprint),
  KEY reward_day (user_id, claimed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcn_texture_uploads (
  texture_id int NOT NULL,
  fingerprint char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reward_remaining int NOT NULL DEFAULT 0,
  PRIMARY KEY (texture_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
