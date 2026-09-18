// api/supabase.js

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
    throw new Error("SUPABASE_URL fehlt.");
}

if (!supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt.");
}

/*
 * WICHTIG:
 *
 * Der Service-Role-Key darf niemals in index.html
 * oder anderem Frontend-Code verwendet werden.
 *
 * Diese Datei liegt ausschließlich im API-/Backend-Bereich.
 */

export const supabase = createClient(
    supabaseUrl,
    supabaseServiceRoleKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);