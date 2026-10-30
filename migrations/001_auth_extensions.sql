-- Additive tables only. Apply explicitly after backing up the legacy database.
CREATE TABLE IF NOT EXISTS mcn_web_sessions (
  sid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY mcn_sessions_user (user_id),
  KEY mcn_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcn_oauth_identities (
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE KEY mcn_identity_user_provider (user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcn_oauth_flows (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  browser_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stage VARCHAR(20) CHARACTER SET ascii NOT NULL,
  payload LONGTEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY mcn_oauth_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcn_email_challenges (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  purpose VARCHAR(30) CHARACTER SET ascii NOT NULL,
  user_id INT UNSIGNED NULL,
  payload LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY mcn_email_user (user_id, purpose),
  KEY mcn_email_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
