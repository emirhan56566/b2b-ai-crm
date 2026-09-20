// api/lead-notes.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function serviceHeaders() {
    return {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json"
    };
}

async function getUser(req) {
    const auth =
        req.headers.authorization ||
        req.headers.Authorization;

    if (!auth || !auth.startsWith("Bearer ")) {
        throw new Error("Nicht authentifiziert.");
    }

    const token = auth.substring(7);

    const response = await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${token}`
            }
        }
    );

    if (!response.ok) {
        throw new Error("Sitzung ungültig.");
    }

    return await response.json();
}

async function verifyLeadOwnership(userId, leadId) {
    const response = await fetch(
        `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(
            leadId
        )}&user_id=eq.${encodeURIComponent(
            userId
        )}&select=id`,
        {
            headers: serviceHeaders()
        }
    );

    if (!response.ok) {
        throw new Error(
            "Lead konnte nicht geprüft werden."
        );
    }

    const leads = await response.json();

    return leads.length > 0;
}

export default async function handler(req, res) {
    try {
        const user = await getUser(req);

        const body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body || {};

        const leadId = String(
            body.lead_id ||
            req.query?.lead_id ||
            ""
        ).trim();

        if (!leadId) {
            return res.status(400).json({
                error: "Lead-ID fehlt."
            });
        }

        const ownsLead =
            await verifyLeadOwnership(
                user.id,
                leadId
            );

        if (!ownsLead) {
            return res.status(404).json({
                error: "Lead nicht gefunden."
            });
        }

        /*
         * GET
         * Aktuelle Gesprächsnotiz laden.
         */
        if (req.method === "GET") {
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(
                    leadId
                )}&user_id=eq.${encodeURIComponent(
                    user.id
                )}&select=id,notes`,
                {
                    headers: serviceHeaders()
                }
            );

            const text =
                await response.text();

            if (!response.ok) {
                throw new Error(
                    text ||
                    "Gesprächsnotiz konnte nicht geladen werden."
                );
            }

            const rows =
                text ? JSON.parse(text) : [];

            return res.status(200).json({
                success: true,
                notes:
                    rows[0]?.notes || ""
            });
        }

        /*
         * POST / PATCH
         * Gesprächsnotiz speichern.
         */
        if (
            req.method === "POST" ||
            req.method === "PATCH"
        ) {
            const notes =
                typeof body.notes === "string"
                    ? body.notes
                    : "";

            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(
                    leadId
                )}&user_id=eq.${encodeURIComponent(
                    user.id
                )}`,
                {
                    method: "PATCH",

                    headers: {
                        ...serviceHeaders(),
                        Prefer:
                            "return=representation"
                    },

                    body: JSON.stringify({
                        notes
                    })
                }
            );

            const text =
                await response.text();

            if (!response.ok) {
                throw new Error(
                    text ||
                    "Gesprächsnotiz konnte nicht gespeichert werden."
                );
            }

            let lead = null;

            try {
                const rows =
                    text ? JSON.parse(text) : [];

                lead =
                    rows[0] || null;
            } catch {
                lead = null;
            }

            return res.status(200).json({
                success: true,
                notes,
                lead
            });
        }

        return res.status(405).json({
            error: "Method Not Allowed"
        });

    } catch (error) {
        console.error(
            "Lead notes API error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Gesprächsnotizen konnten nicht verarbeitet werden."
        });
    }
}