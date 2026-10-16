-- ============================================================
-- Crack SQL — Safe User Profile Update Migration
-- Additive schema changes for mobile number and WhatsApp consent
-- ============================================================

-- Add nullable columns for contact details without rebuilding table
alter table public.profiles
  add column if not exists mobile_number text,
  add column if not exists whatsapp_consent boolean default false,
  add column if not exists whatsapp_consent_at timestamptz;

-- Reload PostgREST schema cache so new columns are recognized by API client
notify pgrst, 'reload schema';
