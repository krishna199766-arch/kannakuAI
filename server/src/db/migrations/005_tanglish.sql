-- Tanglish (Tamil in English letters) as a voice reply language. Safe to re-run.
ALTER TABLE voice_sessions DROP CONSTRAINT IF EXISTS voice_sessions_lang_check;
ALTER TABLE voice_sessions ADD CONSTRAINT voice_sessions_lang_check CHECK (lang IN ('en','ta','tanglish'));
