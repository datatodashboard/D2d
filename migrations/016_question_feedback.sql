-- ============================================================
-- Migration 016: Question Feedback Table & Admin Access
-- ============================================================

CREATE TABLE IF NOT EXISTS public.question_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  username text,
  question_id text,
  question_title text,
  domain text,
  level text,
  emoji text NOT NULL,
  feedback_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.question_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert question feedback" ON public.question_feedback;
CREATE POLICY "Anyone can insert question feedback" ON public.question_feedback
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view all question feedback" ON public.question_feedback;
DROP POLICY IF EXISTS "Users can view their own question feedback" ON public.question_feedback;
CREATE POLICY "Users can view their own question feedback" ON public.question_feedback
  FOR SELECT USING (auth.uid() = user_id OR public.is_admin());

GRANT SELECT, INSERT ON public.question_feedback TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
