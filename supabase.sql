-- ========================================
-- MAPA DE ALETHEIA
-- BANCO DE DADOS COLABORATIVO
-- ========================================

begin;

-- NORMALIZAÇÃO DOS NOMES

create or replace function
public.aletheia_normalize_label(input_text text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select translate(
    lower(
      btrim(
        regexp_replace(
          input_text,
          '[[:space:]]+',
          ' ',
          'g'
        )
      )
    ),
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );
$$;

-- ========================================
-- CATEGORIAS PRINCIPAIS
-- ========================================

create table if not exists
public.aletheia_category_groups (

  id text primary key
    check (id ~ '^[a-z][a-z0-9_]{0,63}$'),

  label text not null
    check (char_length(btrim(label)) between 1 and 80),

  color text not null default '#b8e2ff'
    check (color ~ '^#[0-9a-fA-F]{6}$'),

  icon_kind text not null default 'outros'
    check (
      icon_kind in (
        'templo',
        'entidade',
        'planta',
        'dungeon',
        'missao',
        'minerio',
        'material',
        'outros'
      )
    ),

  sort_order integer not null default 1000

);

create unique index if not exists
aletheia_unique_group_name
on public.aletheia_category_groups (
  public.aletheia_normalize_label(label)
);

-- ========================================
-- SUBCATEGORIAS
-- ========================================

create table if not exists
public.aletheia_categories (

  id text primary key
    check (id ~ '^[a-z][a-z0-9_]{0,63}$'),

  group_id text not null
    references public.aletheia_category_groups(id)
    on delete restrict,

  label text not null
    check (char_length(btrim(label)) between 1 and 80),

  symbol text not null default '•'
    check (char_length(symbol) <= 16),

  sort_order integer not null default 1000

);

create unique index if not exists
aletheia_unique_category_name
on public.aletheia_categories (
  group_id,
  public.aletheia_normalize_label(label)
);

-- ========================================
-- MARCADORES
-- ========================================

create table if not exists
public.aletheia_locations (

  id uuid primary key default gen_random_uuid(),

  name text not null
    check (char_length(name) between 1 and 100),

  category text not null
    check (category ~ '^[a-z][a-z0-9_]{0,63}$'),

  description text not null default ''
    check (char_length(description) <= 2000),

  lat double precision not null
    check (lat between 0 and 8192),

  lng double precision not null
    check (lng between 0 and 8192),

  icon text
    check (
      icon is null or (
        char_length(icon) <= 120000
        and icon ~ '^data:image/(png|webp|jpeg);base64,'
      )
    ),

  photo text
    check (
      photo is null or (
        char_length(photo) <= 350000
        and photo ~ '^data:image/(png|webp|jpeg);base64,'
      )
    ),

  created_at timestamptz not null default now()

);

-- ========================================
-- CONTROLE DA INSTALAÇÃO
-- ========================================

create table if not exists
public.aletheia_catalog_migrations (

  id text primary key

);

alter table public.aletheia_catalog_migrations
enable row level security;

revoke all
on public.aletheia_catalog_migrations
from public, anon, authenticated;

-- ========================================
-- CATEGORIAS INICIAIS
-- ========================================

do $$

begin

  if not exists (

    select 1
    from public.aletheia_catalog_migrations
    where id = 'catalogo_inicial_v1'

  ) then

    insert into public.aletheia_category_groups
    (id, label, color, icon_kind, sort_order)

    values

    ('plantas',
     'Plantas raras',
     '#a8d5a2',
     'planta', 0),

    ('olimpianos',
     'Templos dos 12 deuses olimpianos',
     '#b8e2ff',
     'templo', 1),

    ('nao_olimpianos',
     'Templos dos não olimpianos',
     '#c7b4ea',
     'templo', 2),

    ('entidades',
     'Lugares de entidades',
     '#a4c9ed',
     'entidade', 3),

    ('missoes',
     'Missões',
     '#b8e2ff',
     'missao', 4),

    ('minerios',
     'Minérios',
     '#aebfd5',
     'minerio', 5),

    ('materiais',
     'Materiais',
     '#d4e5f3',
     'material', 6),

    ('dungeons',
     'Dungeons',
     '#e2a6ae',
     'dungeon', 7),

    ('outros',
     'Outros',
     '#b4c7d8',
     'outros', 8)

    on conflict (id) do nothing;

    -- ========================================
    -- SUBCATEGORIAS INICIAIS
    -- ========================================

    insert into public.aletheia_categories
    (id, group_id, label, symbol, sort_order)

    values

    -- PLANTAS RARAS

    ('plantas_raras',
     'plantas', 'Plantas raras (geral)', '❋', 0),

    ('planta_maryfontali',
     'plantas', 'Maryfontali', '❋', 1),

    ('planta_nevoa_lunaris',
     'plantas', 'Névoa lunaris', '❋', 2),

    ('planta_noctis_flor',
     'plantas', 'Noctis flor', '❋', 3),

    ('planta_ramo_bloom',
     'plantas', 'Ramo Bloom', '❋', 4),

    ('planta_seelie_imaculado',
     'plantas', 'Seelie imaculado', '❋', 5),

    ('planta_verbena',
     'plantas', 'Verbena', '❋', 6),

    ('planta_bela_pura',
     'plantas', 'Bela pura', '❋', 7),

    ('planta_donzela_craken',
     'plantas', 'Donzela craken', '❋', 8),

    ('planta_adularis_minor',
     'plantas', 'Adularis minor', '❋', 9),

    -- TEMPLOS DOS OLIMPIANOS

    ('templo_zeus',
     'olimpianos', 'Zeus', 'ϟ', 0),

    ('templo_hera',
     'olimpianos', 'Hera', '♕', 1),

    ('templo_poseidon',
     'olimpianos', 'Poseidon', '♆', 2),

    ('templo_demeter',
     'olimpianos', 'Deméter', '❋', 3),

    ('templo_atena',
     'olimpianos', 'Atena', '♜', 4),

    ('templo_apolo',
     'olimpianos', 'Apolo', '☀', 5),

    ('templo_artemis',
     'olimpianos', 'Ártemis', '☾', 6),

    ('templo_ares',
     'olimpianos', 'Ares', '⚔', 7),

    ('templo_afrodite',
     'olimpianos', 'Afrodite', '♡', 8),

    ('templo_hefesto',
     'olimpianos', 'Hefesto', '⚒', 9),

    ('templo_hermes',
     'olimpianos', 'Hermes', '↗', 10),

    ('templo_dionisio',
     'olimpianos', 'Dionísio', '❦', 11),

    -- TEMPLOS DOS NÃO OLIMPIANOS

    ('templo_hestia',
     'nao_olimpianos', 'Héstia', '♨', 0),

    ('templo_iris',
     'nao_olimpianos', 'Íris', '✧', 1),

    ('templo_hades',
     'nao_olimpianos', 'Hades', '♜', 2),

    ('templo_hecate',
     'nao_olimpianos', 'Hécate', '☾', 3),

    ('templo_eris',
     'nao_olimpianos', 'Éris', '✧', 4),

    ('templo_hipnos',
     'nao_olimpianos', 'Hipnos', '☾', 5),

    ('templo_tanatos',
     'nao_olimpianos', 'Tânatos', '☠', 6),

    ('templo_despoina',
     'nao_olimpianos', 'Despoina', '✧', 7),

    ('templo_persefone',
     'nao_olimpianos', 'Perséfone', '❋', 8),

    ('templo_outro',
     'nao_olimpianos', 'Outro templo', '✧', 9),

    -- LUGARES DE ENTIDADES

    ('entidade_pasifae',
     'entidades', 'Pasífae', '✧', 0),

    ('entidade_circe',
     'entidades', 'Circe', '✧', 1),

    ('entidade_quiron',
     'entidades', 'Quíron', '✧', 2),

    ('entidade_helio',
     'entidades', 'Hélio', '☀', 3),

    ('entidade_selene',
     'entidades', 'Selene', '☾', 4),

    ('entidade_moiras',
     'entidades', 'Moiras', '✧', 5),

    ('entidade_aracne',
     'entidades', 'Aracne', '✷', 6),

    ('entidade_medusa',
     'entidades', 'Medusa', '✧', 7),

    ('entidade_equidina',
     'entidades', 'Equidina', '✧', 8),

    -- MISSÕES

    ('missoes',
     'missoes', 'Missões', '!', 0),

    -- MINÉRIOS

    ('minerios',
     'minerios', 'Minérios', '◆', 0),

    -- MATERIAIS

    ('materiais',
     'materiais', 'Materiais', '▣', 0),

    -- DUNGEONS

    ('dungeon_caveira',
     'dungeons', 'Dungeon da Caveira', '☠', 0),

    ('dungeon_aranha',
     'dungeons', 'Dungeon da Aranha', '✷', 1),

    ('dungeon_agua',
     'dungeons', 'Dungeon da Água', '≈', 2),

    -- OUTROS

    ('outros',
     'outros', 'Outros (geral)', '•', 0),

    ('outros_frutos',
     'outros', 'Frutos', '❋', 1),

    ('outros_noz',
     'outros', 'Noz', '◆', 2),

    ('outros_agua_consagrada',
     'outros', 'Água consagrada', '≈', 3)

    on conflict (id) do nothing;

    insert into public.aletheia_catalog_migrations
    (id)
    values ('catalogo_inicial_v1');

  end if;

end $$;

-- ========================================
-- PROTEGER CATEGORIAS COM MARCADORES
-- ========================================

do $$

begin

  if not exists (

    select 1
    from pg_constraint

    where conname = 'aletheia_location_category_fk'

    and conrelid =
      'public.aletheia_locations'::regclass

  ) then

    alter table public.aletheia_locations

    add constraint aletheia_location_category_fk

    foreign key (category)

    references public.aletheia_categories(id)

    on delete restrict;

  end if;

end $$;

-- ÍNDICES

create index if not exists
aletheia_locations_category_idx
on public.aletheia_locations(category);

create index if not exists
aletheia_categories_group_idx
on public.aletheia_categories(group_id);

-- ========================================
-- PERMISSÕES DO BANCO DE DADOS
-- ========================================

alter table public.aletheia_category_groups
enable row level security;

alter table public.aletheia_categories
enable row level security;

alter table public.aletheia_locations
enable row level security;

grant usage on schema public
to anon, authenticated;

grant select, insert, update, delete
on public.aletheia_category_groups
to anon, authenticated;

grant select, insert, update, delete
on public.aletheia_categories
to anon, authenticated;

grant select, insert, update, delete
on public.aletheia_locations
to anon, authenticated;

-- PERMISSÕES DAS CATEGORIAS PRINCIPAIS

drop policy if exists aletheia_groups_access
on public.aletheia_category_groups;

create policy aletheia_groups_access
on public.aletheia_category_groups
for all
to anon, authenticated
using (true)
with check (true);

-- PERMISSÕES DAS SUBCATEGORIAS

drop policy if exists aletheia_categories_access
on public.aletheia_categories;

create policy aletheia_categories_access
on public.aletheia_categories
for all
to anon, authenticated
using (true)
with check (true);

-- PERMISSÕES DOS MARCADORES

drop policy if exists aletheia_locations_access
on public.aletheia_locations;

create policy aletheia_locations_access
on public.aletheia_locations
for all
to anon, authenticated
using (true)
with check (true);

-- ========================================
-- SINCRONIZAÇÃO EM TEMPO REAL
-- ========================================

do $$

declare

  target_table text;

begin

  foreach target_table in array array[

    'aletheia_category_groups',
    'aletheia_categories',
    'aletheia_locations'

  ]

  loop

    if not exists (

      select 1

      from pg_publication_tables as pt

      where pt.pubname = 'supabase_realtime'

      and pt.schemaname = 'public'

      and pt.tablename = target_table

    ) then

      execute format(

        'alter publication supabase_realtime add table public.%I',

        target_table

      );

    end if;

  end loop;

end $$;

commit;