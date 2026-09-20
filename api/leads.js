// api/leads.js

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

const ANON_KEY =
    process.env.SUPABASE_ANON_KEY;


function serviceHeaders() {
    return {
        apikey: SERVICE_KEY,
        Authorization:
            `Bearer ${SERVICE_KEY}`,
        "Content-Type":
            "application/json"
    };
}


async function getUser(req) {

    const auth =
        req.headers.authorization ||
        req.headers.Authorization;

    if (!auth?.startsWith("Bearer ")) {
        throw new Error(
            "Nicht authentifiziert."
        );
    }

    const token =
        auth.substring(7);

    const response =
        await fetch(
            `${SUPABASE_URL}/auth/v1/user`,
            {
                headers: {
                    apikey: ANON_KEY,
                    Authorization:
                        `Bearer ${token}`
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            "Sitzung ungültig."
        );
    }

    return await response.json();
}


async function getExistingLeads(
    userId,
    companyIds
) {

    if (!companyIds.length) {
        return [];
    }

    const response =
        await fetch(
            `${SUPABASE_URL}/rest/v1/leads?user_id=eq.${encodeURIComponent(
                userId
            )}&select=*`,
            {
                headers:
                    serviceHeaders()
            }
        );

    if (!response.ok) {
        throw new Error(
            "Bestehende Leads konnten nicht geladen werden."
        );
    }

    const leads =
        await response.json();

    return leads.filter(
        lead =>
            companyIds.includes(
                lead.company_id
            )
    );
}


async function createLead(
    userId,
    companyId
) {

    const response =
        await fetch(
            `${SUPABASE_URL}/rest/v1/leads`,
            {
                method: "POST",

                headers: {
                    ...serviceHeaders(),
                    Prefer:
                        "return=representation"
                },

                body: JSON.stringify({
                    user_id:
                        userId,

                    company_id:
                        companyId,

                    status:
                        "new",

                    status_updated_at:
                        new Date().toISOString(),

                    pipeline_value:
                        2,

                    source:
                        "company_database"
                })
            }
        );

    const text =
        await response.text();

    if (!response.ok) {
        throw new Error(
            text ||
            "Lead konnte nicht angelegt werden."
        );
    }

    try {

        const rows =
            JSON.parse(text);

        return rows[0] || null;

    } catch {

        return null;
    }
}


/* ==================================================
   STATUS VALIDIERUNG
================================================== */

const VALID_STATUSES = [
    "new",
    "called",
    "not_reached",
    "negotiation",
    "calculation",
    "signed",
    "no_interest"
];


function isValidStatus(status) {

    return VALID_STATUSES.includes(
        String(status || "")
    );
}


/* ==================================================
   HANDLER
================================================== */

export default async function handler(
    req,
    res
) {

    try {

        const user =
            await getUser(req);


        /* ==========================================
           GET — Leads laden
        ========================================== */

        if (req.method === "GET") {

            const response =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/leads?user_id=eq.${encodeURIComponent(
                        user.id
                    )}&select=*,companies(*)&order=created_at.desc`,
                    {
                        headers:
                            serviceHeaders()
                    }
                );

            const text =
                await response.text();

            if (!response.ok) {

                throw new Error(
                    text ||
                    "Leads konnten nicht geladen werden."
                );
            }

            const leads =
                JSON.parse(text);

            return res.status(200).json({
                leads
            });
        }


        /* ==========================================
           POST — Unternehmen → Leads
        ========================================== */

        if (req.method === "POST") {

            const body =
                typeof req.body === "string"
                    ? JSON.parse(req.body)
                    : req.body || {};

            const companyIds =
                Array.isArray(
                    body.company_ids
                )
                    ? [
                        ...new Set(
                            body.company_ids
                                .filter(Boolean)
                        )
                    ]
                    : [];

            if (!companyIds.length) {

                return res.status(400).json({
                    error:
                        "Keine Unternehmen ausgewählt."
                });
            }


            const existing =
                await getExistingLeads(
                    user.id,
                    companyIds
                );


            const existingCompanyIds =
                new Set(
                    existing.map(
                        lead =>
                            lead.company_id
                    )
                );


            const newCompanyIds =
                companyIds.filter(
                    id =>
                        !existingCompanyIds.has(
                            id
                        )
                );


            const created = [];


            for (
                const companyId
                of newCompanyIds
            ) {

                try {

                    const lead =
                        await createLead(
                            user.id,
                            companyId
                        );

                    if (lead) {
                        created.push(
                            lead
                        );
                    }

                } catch (error) {

                    console.error(
                        "Lead create error:",
                        error
                    );
                }
            }


            return res.status(200).json({
                success:
                    true,

                created:
                    created.length,

                skipped:
                    companyIds.length -
                    created.length,

                leads:
                    created
            });
        }


        /* ==========================================
           PATCH — Lead-Status ändern
        ========================================== */

        if (req.method === "PATCH") {

            const body =
                typeof req.body === "string"
                    ? JSON.parse(req.body)
                    : req.body || {};

            const leadId =
                String(
                    body.lead_id || ""
                ).trim();

            const status =
                String(
                    body.status || ""
                ).trim();


            if (!leadId) {

                return res.status(400).json({
                    error:
                        "Lead-ID fehlt."
                });
            }


            if (!isValidStatus(status)) {

                return res.status(400).json({
                    error:
                        "Ungültiger Lead-Status."
                });
            }


            /*
             * Erst prüfen, ob der Lead
             * wirklich dem eingeloggten
             * Benutzer gehört.
             */

            const ownershipResponse =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(
                        leadId
                    )}&user_id=eq.${encodeURIComponent(
                        user.id
                    )}&select=id`,
                    {
                        headers:
                            serviceHeaders()
                    }
                );


            if (!ownershipResponse.ok) {

                throw new Error(
                    "Lead konnte nicht geprüft werden."
                );
            }


            const ownership =
                await ownershipResponse.json();


            if (!ownership.length) {

                return res.status(404).json({
                    error:
                        "Lead nicht gefunden."
                });
            }


            const updateResponse =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(
                        leadId
                    )}&user_id=eq.${encodeURIComponent(
                        user.id
                    )}`,
                    {
                        method:
                            "PATCH",

                        headers: {
                            ...serviceHeaders(),
                            Prefer:
                                "return=representation"
                        },

                        body:
                            JSON.stringify({
                                status,
                                status_updated_at:
                                    new Date().toISOString(),
                                pipeline_value:
                                    2
                            })
                    }
                );


            const text =
                await updateResponse.text();


            if (!updateResponse.ok) {

                throw new Error(
                    text ||
                    "Lead-Status konnte nicht gespeichert werden."
                );
            }


            let lead = null;

            try {

                const rows =
                    JSON.parse(text);

                lead =
                    rows[0] || null;

            } catch {
                lead = null;
            }


            return res.status(200).json({
                success:
                    true,

                lead
            });
        }


        return res.status(405).json({
            error:
                "Method Not Allowed"
        });


    } catch (error) {

        console.error(
            "Leads API error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Leads konnten nicht verarbeitet werden."
        });
    }
}