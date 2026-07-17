-- ============================================================================
-- Advosy Growth - storage buckets export
-- Source project: andzztvmaleiefxcfjwh | Exported: 2026-07-17
-- 2 buckets, both PUBLIC, no file size limit, no MIME restrictions,
-- and NO custom storage.objects RLS policies in the source project.
-- (Bucket OBJECTS/files are not exported - copy files separately if needed.)
-- ============================================================================

-- brand-assets: brand logos, uniforms, reference images (Nano Banana pipeline refs)
insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do update set public = excluded.public;

-- creatives: generated ad creative images
insert into storage.buckets (id, name, public)
values ('creatives', 'creatives', true)
on conflict (id) do update set public = excluded.public;
