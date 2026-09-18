// api/auth-user.js

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
    throw new Error("SUPABASE_URL fehlt.");
}

if (!supabaseAnonKey) {
    throw new Error("SUPABASE_ANON_KEY fehlt.");
}

const supabase = createClient(
    supabaseUrl,
    supabaseAnonKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({
            success: false,
            error: "Method not allowed"
        });
    }

    try {
        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                error: "Nicht authentifiziert."
            });
        }

        const token =
            authorization.substring(7).trim();

        if (!token) {
            return res.status(401).json({
                success: false,
                error: "Kein Access Token vorhanden."
            });
        }

        const {
            data,
            error
        } = await supabase.auth.getUser(token);

        if (error || !data?.user) {
            return res.status(401).json({
                success: false,
                error: "Ungültige oder abgelaufene Sitzung."
            });
        }

        return res.status(200).json({
            success: true,
            user: {
                id: data.user.id,
                email: data.user.email,
                created_at: data.user.created_at
            }
        });

    } catch (error) {
        console.error("auth-user error:", error);

        return res.status(500).json({
            success: false,
            error: "Interner Serverfehler."
        });
    }
}