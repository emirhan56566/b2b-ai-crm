-- =========================================================
-- B2B AI CRM - Supabase Datenbank
-- Datei: supabase.sql
-- =========================================================

create extension if not exists pgcrypto;

-- =========================================================
-- 1. PROFILES
-- =========================================================

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    full_name text,
    company_name text,
    role text default 'sales',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- =========================================================
-- 2. COMPANIES
-- =========================================================

create table if not exists public.companies (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    name text not null,
    legal_name text,

    industry text,

    phone text,
    email text,
    website text,

    street text,
    house_number text,
    postal_code text,
    city text,
    country text default 'Deutschland',

    employees integer,

    description text,

    latitude numeric,
    longitude numeric,

    source text,
    source_url text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists companies_user_id_idx
on public.companies(user_id);

create index if not exists companies_name_idx
on public.companies(name);

create index if not exists companies_postal_code_idx
on public.companies(postal_code);

create index if not exists companies_industry_idx
on public.companies(industry);

-- =========================================================
-- 3. CONTACTS
-- =========================================================

create table if not exists public.contacts (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    company_id uuid references public.companies(id) on delete cascade,

    first_name text,
    last_name text,

    job_title text,

    phone text,
    mobile text,
    email text,

    linkedin_url text,

    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists contacts_user_id_idx
on public.contacts(user_id);

create index if not exists contacts_company_id_idx
on public.contacts(company_id);

-- =========================================================
-- 4. LEADS
-- =========================================================

create table if not exists public.leads (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    company_id uuid references public.companies(id) on delete set null,
    contact_id uuid references public.contacts(id) on delete set null,

    status text not null default 'new',

    priority text not null default 'normal',

    score integer,

    assigned_to uuid references auth.users(id) on delete set null,

    last_contacted_at timestamptz,
    next_follow_up_at timestamptz,

    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint leads_status_check
    check (
        status in (
            'new',
            'to_contact',
            'called',
            'reached',
            'not_reached',
            'qualified',
            'callback',
            'appointment',
            'offer',
            'won',
            'lost',
            'no_interest',
            'wrong_number'
        )
    ),

    constraint leads_priority_check
    check (
        priority in (
            'low',
            'normal',
            'high'
        )
    ),

    constraint leads_score_check
    check (
        score is null or score between 0 and 100
    )
);

create index if not exists leads_user_id_idx
on public.leads(user_id);

create index if not exists leads_company_id_idx
on public.leads(company_id);

create index if not exists leads_status_idx
on public.leads(status);

create index if not exists leads_follow_up_idx
on public.leads(next_follow_up_at);

-- =========================================================
-- 5. LEAD SEARCHES
-- =========================================================

create table if not exists public.lead_searches (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    industry text,
    postal_code text,

    radius_km integer,

    employees_min integer,
    employees_max integer,

    requested_count integer default 50,

    additional_criteria text,
    exclude_criteria text,

    status text not null default 'pending',

    results_count integer default 0,

    search_parameters jsonb default '{}'::jsonb,

    error_message text,

    started_at timestamptz,
    completed_at timestamptz,

    created_at timestamptz not null default now(),

    constraint lead_searches_status_check
    check (
        status in (
            'pending',
            'running',
            'completed',
            'failed'
        )
    )
);

create index if not exists lead_searches_user_id_idx
on public.lead_searches(user_id);

create index if not exists lead_searches_created_at_idx
on public.lead_searches(created_at desc);

-- =========================================================
-- 6. LEAD SOURCES
-- =========================================================

create table if not exists public.lead_sources (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    lead_id uuid references public.leads(id) on delete cascade,

    company_id uuid references public.companies(id) on delete cascade,

    source_name text,
    source_url text,

    source_type text,

    retrieved_at timestamptz not null default now(),

    metadata jsonb default '{}'::jsonb,

    created_at timestamptz not null default now()
);

create index if not exists lead_sources_lead_id_idx
on public.lead_sources(lead_id);

create index if not exists lead_sources_company_id_idx
on public.lead_sources(company_id);

-- =========================================================
-- 7. ACTIVITIES
-- =========================================================

create table if not exists public.activities (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    lead_id uuid references public.leads(id) on delete cascade,

    company_id uuid references public.companies(id) on delete cascade,

    contact_id uuid references public.contacts(id) on delete set null,

    type text not null,

    subject text,

    description text,

    metadata jsonb default '{}'::jsonb,

    created_at timestamptz not null default now(),

    constraint activities_type_check
    check (
        type in (
            'note',
            'call',
            'email',
            'meeting',
            'task',
            'status_change',
            'lead_created',
            'other'
        )
    )
);

create index if not exists activities_user_id_idx
on public.activities(user_id);

create index if not exists activities_lead_id_idx
on public.activities(lead_id);

create index if not exists activities_created_at_idx
on public.activities(created_at desc);

-- =========================================================
-- 8. CALLS
-- =========================================================

create table if not exists public.calls (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    lead_id uuid references public.leads(id) on delete set null,
    company_id uuid references public.companies(id) on delete set null,
    contact_id uuid references public.contacts(id) on delete set null,

    direction text not null default 'outbound',

    outcome text,

    phone_number text,

    duration_seconds integer,

    notes text,

    ai_summary text,

    recording_url text,

    started_at timestamptz,
    ended_at timestamptz,

    created_at timestamptz not null default now(),

    constraint calls_direction_check
    check (
        direction in (
            'inbound',
            'outbound'
        )
    )
);

create index if not exists calls_user_id_idx
on public.calls(user_id);

create index if not exists calls_lead_id_idx
on public.calls(lead_id);

create index if not exists calls_started_at_idx
on public.calls(started_at desc);

-- =========================================================
-- 9. TASKS
-- =========================================================

create table if not exists public.tasks (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    lead_id uuid references public.leads(id) on delete cascade,
    company_id uuid references public.companies(id) on delete cascade,
    contact_id uuid references public.contacts(id) on delete set null,

    title text not null,

    description text,

    task_type text default 'follow_up',

    priority text default 'normal',

    due_at timestamptz,

    completed_at timestamptz,

    assigned_to uuid references auth.users(id) on delete set null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint tasks_priority_check
    check (
        priority in (
            'low',
            'normal',
            'high'
        )
    )
);

create index if not exists tasks_user_id_idx
on public.tasks(user_id);

create index if not exists tasks_due_at_idx
on public.tasks(due_at);

create index if not exists tasks_completed_idx
on public.tasks(completed_at);

-- =========================================================
-- 10. APPOINTMENTS
-- =========================================================

create table if not exists public.appointments (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    lead_id uuid references public.leads(id) on delete set null,
    company_id uuid references public.companies(id) on delete set null,
    contact_id uuid references public.contacts(id) on delete set null,

    title text not null,

    description text,

    location text,

    start_at timestamptz not null,
    end_at timestamptz not null,

    status text default 'scheduled',

    external_calendar_id text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint appointments_status_check
    check (
        status in (
            'scheduled',
            'completed',
            'cancelled',
            'no_show'
        )
    ),

    constraint appointments_time_check
    check (
        end_at > start_at
    )
);

create index if not exists appointments_user_id_idx
on public.appointments(user_id);

create index if not exists appointments_start_at_idx
on public.appointments(start_at);

-- =========================================================
-- 11. DEALS / PIPELINE
-- =========================================================

create table if not exists public.deals (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    lead_id uuid references public.leads(id) on delete set null,
    company_id uuid references public.companies(id) on delete set null,
    contact_id uuid references public.contacts(id) on delete set null,

    title text not null,

    stage text not null default 'new',

    value numeric(12,2) default 0,

    probability integer default 0,

    expected_close_date date,

    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint deals_stage_check
    check (
        stage in (
            'new',
            'qualified',
            'appointment',
            'offer',
            'negotiation',
            'won',
            'lost'
        )
    ),

    constraint deals_probability_check
    check (
        probability between 0 and 100
    )
);

create index if not exists deals_user_id_idx
on public.deals(user_id);

create index if not exists deals_stage_idx
on public.deals(stage);

-- =========================================================
-- 12. CAMPAIGNS
-- =========================================================

create table if not exists public.campaigns (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    name text not null,

    description text,

    status text default 'draft',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint campaigns_status_check
    check (
        status in (
            'draft',
            'active',
            'paused',
            'completed'
        )
    )
);

-- =========================================================
-- 13. EMAIL TEMPLATES
-- =========================================================

create table if not exists public.email_templates (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    name text not null,

    subject text not null,

    body text not null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- =========================================================
-- 14. PROMPT VERSIONEN
-- =========================================================

create table if not exists public.prompt_versions (
    id uuid primary key default gen_random_uuid(),

    user_id uuid references auth.users(id) on delete cascade,

    name text not null,

    version integer not null,

    prompt_type text not null,

    system_prompt text not null,

    is_active boolean not null default false,

    created_at timestamptz not null default now(),

    unique(user_id, name, version)
);

create index if not exists prompt_versions_type_idx
on public.prompt_versions(prompt_type);

create unique index if not exists one_active_prompt_per_type
on public.prompt_versions(user_id, prompt_type)
where is_active = true;

-- =========================================================
-- 15. AUTOMATION RULES
-- =========================================================

create table if not exists public.automation_rules (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references auth.users(id) on delete cascade,

    name text not null,

    event_type text not null,

    conditions jsonb default '{}'::jsonb,

    actions jsonb default '[]'::jsonb,

    is_active boolean default true,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- =========================================================
-- UPDATED_AT FUNKTION
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- =========================================================
-- UPDATED_AT TRIGGER
-- =========================================================

drop trigger if exists profiles_updated_at on public.profiles;

create trigger profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();


drop trigger if exists companies_updated_at on public.companies;

create trigger companies_updated_at
before update on public.companies
for each row
execute function public.set_updated_at();


drop trigger if exists contacts_updated_at on public.contacts;

create trigger contacts_updated_at
before update on public.contacts
for each row
execute function public.set_updated_at();


drop trigger if exists leads_updated_at on public.leads;

create trigger leads_updated_at
before update on public.leads
for each row
execute function public.set_updated_at();


drop trigger if exists tasks_updated_at on public.tasks;

create trigger tasks_updated_at
before update on public.tasks
for each row
execute function public.set_updated_at();


drop trigger if exists appointments_updated_at on public.appointments;

create trigger appointments_updated_at
before update on public.appointments
for each row
execute function public.set_updated_at();


drop trigger if exists deals_updated_at on public.deals;

create trigger deals_updated_at
before update on public.deals
for each row
execute function public.set_updated_at();


drop trigger if exists campaigns_updated_at on public.campaigns;

create trigger campaigns_updated_at
before update on public.campaigns
for each row
execute function public.set_updated_at();


drop trigger if exists email_templates_updated_at on public.email_templates;

create trigger email_templates_updated_at
before update on public.email_templates
for each row
execute function public.set_updated_at();


drop trigger if exists automation_rules_updated_at on public.automation_rules;

create trigger automation_rules_updated_at
before update on public.automation_rules
for each row
execute function public.set_updated_at();

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.leads enable row level security;
alter table public.lead_searches enable row level security;
alter table public.lead_sources enable row level security;
alter table public.activities enable row level security;
alter table public.calls enable row level security;
alter table public.tasks enable row level security;
alter table public.appointments enable row level security;
alter table public.deals enable row level security;
alter table public.campaigns enable row level security;
alter table public.email_templates enable row level security;
alter table public.prompt_versions enable row level security;
alter table public.automation_rules enable row level security;

-- =========================================================
-- PROFILES POLICIES
-- =========================================================

drop policy if exists profiles_select on public.profiles;
create policy profiles_select
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert
on public.profiles
for insert
with check (auth.uid() = id);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- =========================================================
-- USER OWNED TABLE POLICIES
-- =========================================================

-- Companies
drop policy if exists companies_all on public.companies;
create policy companies_all
on public.companies
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Contacts
drop policy if exists contacts_all on public.contacts;
create policy contacts_all
on public.contacts
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Leads
drop policy if exists leads_all on public.leads;
create policy leads_all
on public.leads
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Lead Searches
drop policy if exists lead_searches_all on public.lead_searches;
create policy lead_searches_all
on public.lead_searches
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Lead Sources
drop policy if exists lead_sources_all on public.lead_sources;
create policy lead_sources_all
on public.lead_sources
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Activities
drop policy if exists activities_all on public.activities;
create policy activities_all
on public.activities
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Calls
drop policy if exists calls_all on public.calls;
create policy calls_all
on public.calls
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Tasks
drop policy if exists tasks_all on public.tasks;
create policy tasks_all
on public.tasks
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Appointments
drop policy if exists appointments_all on public.appointments;
create policy appointments_all
on public.appointments
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Deals
drop policy if exists deals_all on public.deals;
create policy deals_all
on public.deals
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Campaigns
drop policy if exists campaigns_all on public.campaigns;
create policy campaigns_all
on public.campaigns
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Email Templates
drop policy if exists email_templates_all on public.email_templates;
create policy email_templates_all
on public.email_templates
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Prompt Versions
drop policy if exists prompt_versions_all on public.prompt_versions;
create policy prompt_versions_all
on public.prompt_versions
for all
using (
    auth.uid() = user_id
    or user_id is null
)
with check (
    auth.uid() = user_id
    or user_id is null
);

-- Automation Rules
drop policy if exists automation_rules_all on public.automation_rules;
create policy automation_rules_all
on public.automation_rules
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- =========================================================
-- ENDE
-- =========================================================