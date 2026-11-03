-- Additive, per-character Minecraft Services social data. No legacy columns change.
CREATE TABLE IF NOT EXISTS mcn_social_profiles (
  profile_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  player_id INT UNSIGNED NOT NULL,
  friends_enabled TINYINT(1) NOT NULL DEFAULT 1,
  accept_invites TINYINT(1) NOT NULL DEFAULT 1,
  profanity_filter TINYINT(1) NOT NULL DEFAULT 0,
  presence_status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'OFFLINE',
  last_seen BIGINT UNSIGNED NULL,
  presence_token VARCHAR(100) CHARACTER SET ascii NULL,
  UNIQUE KEY mcn_social_player (player_id),
  FOREIGN KEY (player_id) REFERENCES players(pid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcn_friendships (
  profile_low CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_high CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_by CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  accepted TINYINT(1) NOT NULL DEFAULT 0,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_low, profile_high),
  KEY mcn_friendships_high (profile_high),
  FOREIGN KEY (profile_low) REFERENCES mcn_social_profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_high) REFERENCES mcn_social_profiles(profile_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
