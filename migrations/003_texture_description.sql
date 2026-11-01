-- Preserve existing descriptions while allowing multi-line Markdown.
-- TEXT can store at most 65535 UTF-8 bytes; the application validates this limit.
ALTER TABLE textures_description MODIFY description TEXT COLLATE utf8mb4_unicode_ci NOT NULL;
