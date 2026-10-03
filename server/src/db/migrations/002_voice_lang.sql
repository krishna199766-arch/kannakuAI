-- Language the voice session speaks (readbacks, questions, answers).
-- Written to be safe to re-run: an interrupted earlier attempt may have added the columns already.
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS lang text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ta'));
ALTER TABLE voice_turns ADD COLUMN IF NOT EXISTS lang text;
