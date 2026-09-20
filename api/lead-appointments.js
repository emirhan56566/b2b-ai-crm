// api/lead-appointments.js

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

    if (!auth?.startsWith("Bearer ")) {
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

async function getLeadForUser(userId, leadId) {
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
        throw new Error("Lead konnte nicht geprüft werden.");
    }

    const leads = await response.json();

    return leads[0] || null;
}

export default async function handler(req, res) {
    try {
        const user = await getUser(req);

        /*
         * GET
         * Alle Termine oder Termine eines bestimmten Leads
         */
        if (req.method === "GET") {
            const leadId =
                req.query?.lead_id ||
                new URL(
                    req.url,
                    `http://${req.headers.host || "localhost"}`
                ).searchParams.get("lead_id");

            let url =
                `${SUPABASE_URL}/rest/v1/lead_appointments` +
                `?user_id=eq.${encodeURIComponent(user.id)}` +
                `&select=*,leads(id,company_id,companies(name))` +
                `&order=appointment_date.asc,appointment_time.asc`;

            if (leadId) {
                url +=
                    `&lead_id=eq.${encodeURIComponent(leadId)}`;
            }

            const response = await fetch(
                url,
                {
                    headers: serviceHeaders()
                }
            );

            const text = await response.text();

            if (!response.ok) {
                throw new Error(
                    text || "Termine konnten nicht geladen werden."
                );
            }

            return res.status(200).json({
                appointments: JSON.parse(text)
            });
        }

        /*
         * POST
         * Neuen Termin anlegen
         */
        if (req.method === "POST") {
            const body =
                typeof req.body === "string"
                    ? JSON.parse(req.body)
                    : req.body || {};

            const leadId =
                String(body.lead_id || "").trim();

            const title =
                String(body.title || "").trim();

            const appointmentDate =
                String(body.appointment_date || "").trim();

            const appointmentTime =
                body.appointment_time
                    ? String(body.appointment_time).trim()
                    : null;

            const notes =
                body.notes
                    ? String(body.notes).trim()
                    : null;

            if (!leadId) {
                return res.status(400).json({
                    error: "Lead-ID fehlt."
                });
            }

            if (!title) {
                return res.status(400).json({
                    error: "Titel fehlt."
                });
            }

            /*
             * Datum muss YYYY-MM-DD sein.
             */
            if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
                return res.status(400).json({
                    error: "Ungültiges Termin-Datum."
                });
            }

            /*
             * Uhrzeit darf leer sein.
             */
            if (
                appointmentTime &&
                !/^\d{2}:\d{2}(:\d{2})?$/.test(
                    appointmentTime
                )
            ) {
                return res.status(400).json({
                    error: "Ungültige Termin-Uhrzeit."
                });
            }

            const lead =
                await getLeadForUser(
                    user.id,
                    leadId
                );

            if (!lead) {
                return res.status(404).json({
                    error: "Lead nicht gefunden."
                });
            }

            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/lead_appointments`,
                {
                    method: "POST",

                    headers: {
                        ...serviceHeaders(),
                        Prefer: "return=representation"
                    },

                    body: JSON.stringify({
                        user_id: user.id,
                        lead_id: leadId,
                        title,
                        appointment_date: appointmentDate,
                        appointment_time:
                            appointmentTime || null,
                        notes:
                            notes || null
                    })
                }
            );

            const text = await response.text();

            if (!response.ok) {
                throw new Error(
                    text ||
                    "Termin konnte nicht gespeichert werden."
                );
            }

            let appointment = null;

            try {
                const rows = JSON.parse(text);
                appointment = rows[0] || null;
            } catch {
                appointment = null;
            }

            return res.status(200).json({
                success: true,
                appointment
            });
        }

        /*
         * DELETE
         * Termin löschen
         */
        if (req.method === "DELETE") {
            const url = new URL(
                req.url,
                `http://${req.headers.host || "localhost"}`
            );

            const appointmentId =
                String(
                    req.query?.id ||
                    url.searchParams.get("id") ||
                    ""
                ).trim();

            if (!appointmentId) {
                return res.status(400).json({
                    error: "Termin-ID fehlt."
                });
            }

            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/lead_appointments` +
                `?id=eq.${encodeURIComponent(appointmentId)}` +
                `&user_id=eq.${encodeURIComponent(user.id)}`,
                {
                    method: "DELETE",
                    headers: {
                        ...serviceHeaders(),
                        Prefer: "return=representation"
                    }
                }
            );

            const text = await response.text();

            if (!response.ok) {
                throw new Error(
                    text ||
                    "Termin konnte nicht gelöscht werden."
                );
            }

            return res.status(200).json({
                success: true
            });
        }

        return res.status(405).json({
            error: "Method Not Allowed"
        });

    } catch (error) {
        console.error(
            "Lead appointments API error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Termine konnten nicht verarbeitet werden."
        });
    }
}