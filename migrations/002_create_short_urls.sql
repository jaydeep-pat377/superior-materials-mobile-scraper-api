-- Migration: Create short_urls table in auth_tenant schema
-- Description: Stores short URL records for deep linking into the mobile app
-- Table: auth_tenant.short_urls

CREATE TABLE IF NOT EXISTS auth_tenant.short_urls (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    tenant_slug TEXT NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    click_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP WITH TIME ZONE
);

-- Index on code for fast lookups
CREATE INDEX IF NOT EXISTS idx_short_urls_code ON auth_tenant.short_urls (code);

-- Index on tenant_slug for tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_short_urls_tenant_slug ON auth_tenant.short_urls (tenant_slug);

-- Index on expires_at for cleanup of expired records
CREATE INDEX IF NOT EXISTS idx_short_urls_expires_at ON auth_tenant.short_urls (expires_at)
    WHERE expires_at IS NOT NULL;

-- RPC function for atomic click_count increment (avoids race conditions)
CREATE OR REPLACE FUNCTION auth_tenant.increment_short_url_click(short_url_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE auth_tenant.short_urls
  SET click_count = click_count + 1,
      last_accessed_at = NOW()
  WHERE id = short_url_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE auth_tenant.tenants
ADD COLUMN backend_url character varying(500) DEFAULT NULL;
