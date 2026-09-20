// api/lead-supply.js

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

async function verifyLeadOwnership(
    userId,
    leadId
) {
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

    const leads =
        await response.json();

    return leads.length > 0;
}

const ALLOWED_FIELDS = [
    "delivery_start_date",
    "company_name",
    "business_address",
    "vat_id",
    "malo_id",
    "meter_number",
    "annual_consumption_kwh",
    "current_meter_reading",
    "previous_supplier",
    "previous_customer_number",
    "iban",
    "desired_delivery_date",
    "old_contract_deadline",
    "old_contract_notice",
    "supply_type",
    "notes"
];

function buildPayload(
    body,
    userId,
    leadId
) {
    const payload = {
        user_id: userId,
        lead_id: leadId
    };

    for (const field of ALLOWED_FIELDS) {
        if (body[field] !== undefined) {
            payload[field] = body[field];
        }
    }

    return payload;
}

function validatePayload(payload) {

    if (
        payload.malo_id !== undefined &&
        payload.malo_id !== null &&
        String(payload.malo_id).trim() !== ""
    ) {
        const malo =
            String(payload.malo_id).trim();

        if (!/^\d{11}$/.test(malo)) {
            return "Die MaLo-ID muss genau 11 Ziffern enthalten.";
        }

        payload.malo_id = malo;
    }

    if (
        payload.supply_type !== undefined &&
        payload.supply_type !== null &&
        payload.supply_type !== ""
    ) {
        if (
            !["RLM", "SLP"].includes(
                String(payload.supply_type)
            )
        ) {
            return "Lieferart muss RLM oder SLP sein.";
        }
    }

    if (
        payload.annual_consumption_kwh !== undefined &&
        payload.annual_consumption_kwh !== null &&
        payload.annual_consumption_kwh !== ""
    ) {
        const value =
            Number(
                payload.annual_consumption_kwh
            );

        if (!Number.isFinite(value)) {
            return "Der Jahresverbrauch muss eine Zahl sein.";
        }

        payload.annual_consumption_kwh =
            value;
    }

    if (
        payload.current_meter_reading !== undefined &&
        payload.current_meter_reading !== null &&
        payload.current_meter_reading !== ""
    ) {
        const value =
            Number(
                payload.current_meter_reading
            );

        if (!Number.isFinite(value)) {
            return "Der aktuelle Zählerstand muss eine Zahl sein.";
        }

        payload.current_meter_reading =
            value;
    }

    return null;
}

export default async function handler(
    req,
    res
) {

    try {

        const user =
            await getUser(req);

        const body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body || {};

        const leadId =
            String(
                body.lead_id ||
                req.query?.lead_id ||
                ""
            ).trim();


        /*
         * ==================================================
         * GET
         *
         * Ohne lead_id:
         *   Alle Belieferungen laden.
         *
         * Mit lead_id:
         *   Belieferung dieses Leads laden.
         * ==================================================
         */

        if (req.method === "GET") {

            let url;

            if (leadId) {

                const ownsLead =
                    await verifyLeadOwnership(
                        user.id,
                        leadId
                    );

                if (!ownsLead) {
                    return res.status(404).json({
                        error:
                            "Lead nicht gefunden."
                    });
                }

                url =
                    `${SUPABASE_URL}/rest/v1/lead_supply` +
                    `?user_id=eq.${encodeURIComponent(user.id)}` +
                    `&lead_id=eq.${encodeURIComponent(leadId)}` +
                    `&select=*` +
                    `&limit=1`;

            } else {

                /*
                 * Übersicht:
                 * Alle Belieferungen des Users.
                 */

                url =
                    `${SUPABASE_URL}/rest/v1/lead_supply` +
                    `?user_id=eq.${encodeURIComponent(user.id)}` +
                    `&select=*` +
                    `&order=created_at.desc`;
            }

            const response =
                await fetch(
                    url,
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
                    "Belieferungsdaten konnten nicht geladen werden."
                );
            }

            const rows =
                text
                    ? JSON.parse(text)
                    : [];

            return res.status(200).json({

                success:
                    true,

                supplies:
                    rows,

                /*
                 * Einzelnen Datensatz zusätzlich
                 * zurückgeben, wenn nach lead_id
                 * gefragt wurde.
                 */

                supply:
                    leadId
                        ? (rows[0] || null)
                        : null
            });
        }


        /*
         * ==================================================
         * POST / PATCH
         *
         * Kunde in Belieferung übernehmen
         * bzw. Belieferungsdaten speichern.
         * ==================================================
         */

        if (
            req.method === "POST" ||
            req.method === "PATCH"
        ) {

            if (!leadId) {

                return res.status(400).json({
                    error:
                        "Lead-ID fehlt."
                });
            }

            const ownsLead =
                await verifyLeadOwnership(
                    user.id,
                    leadId
                );

            if (!ownsLead) {

                return res.status(404).json({
                    error:
                        "Lead nicht gefunden."
                });
            }


            const payload =
                buildPayload(
                    body,
                    user.id,
                    leadId
                );


            const validationError =
                validatePayload(
                    payload
                );

            if (validationError) {

                return res.status(400).json({
                    error:
                        validationError
                });
            }


            /*
             * Prüfen, ob bereits ein
             * Belieferungseintrag existiert.
             */

            const existingResponse =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/lead_supply` +
                    `?user_id=eq.${encodeURIComponent(user.id)}` +
                    `&lead_id=eq.${encodeURIComponent(leadId)}` +
                    `&select=id` +
                    `&limit=1`,
                    {
                        headers:
                            serviceHeaders()
                    }
                );

            const existingText =
                await existingResponse.text();

            if (!existingResponse.ok) {

                throw new Error(
                    existingText ||
                    "Belieferung konnte nicht geprüft werden."
                );
            }

            const existing =
                existingText
                    ? JSON.parse(
                        existingText
                    )
                    : [];


            let response;


            /*
             * Bestehenden Datensatz aktualisieren.
             */

            if (existing.length) {

                response =
                    await fetch(
                        `${SUPABASE_URL}/rest/v1/lead_supply` +
                        `?id=eq.${encodeURIComponent(
                            existing[0].id
                        )}` +
                        `&user_id=eq.${encodeURIComponent(
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
                                JSON.stringify(
                                    payload
                                )
                        }
                    );

            }

            /*
             * Neuen Datensatz anlegen.
             */

            else {

                response =
                    await fetch(
                        `${SUPABASE_URL}/rest/v1/lead_supply`,
                        {
                            method:
                                "POST",

                            headers: {
                                ...serviceHeaders(),

                                Prefer:
                                    "return=representation"
                            },

                            body:
                                JSON.stringify(
                                    payload
                                )
                        }
                    );
            }


            const text =
                await response.text();


            if (!response.ok) {

                throw new Error(
                    text ||
                    "Belieferungsdaten konnten nicht gespeichert werden."
                );
            }


            let supply = null;

            try {

                const rows =
                    text
                        ? JSON.parse(text)
                        : [];

                supply =
                    rows[0] || null;

            } catch {

                supply = null;
            }


            /*
             * ==================================================
             * WICHTIG:
             *
             * Sobald die Belieferungsdaten gespeichert wurden,
             * wird der Lead automatisch auf "signed" gesetzt.
             *
             * Dadurch verschwindet er aus der normalen
             * Lead-Liste und gehört zur Belieferung.
             * ==================================================
             */

            const leadUpdateResponse =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/leads` +
                    `?id=eq.${encodeURIComponent(leadId)}` +
                    `&user_id=eq.${encodeURIComponent(user.id)}`,
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
                                status:
                                    "signed",

                                status_updated_at:
                                    new Date().toISOString()
                            })
                    }
                );


            const leadUpdateText =
                await leadUpdateResponse.text();


            if (!leadUpdateResponse.ok) {

                console.error(
                    "Lead status update failed:",
                    leadUpdateText
                );

                throw new Error(
                    "Belieferung wurde gespeichert, aber der Lead konnte nicht auf 'signed' gesetzt werden."
                );
            }


            return res.status(200).json({

                success:
                    true,

                supply,

                lead_status:
                    "signed"
            });
        }


        /*
         * ==================================================
         * DELETE
         * ==================================================
         */

        if (req.method === "DELETE") {

            if (!leadId) {

                return res.status(400).json({
                    error:
                        "Lead-ID fehlt."
                });
            }

            const ownsLead =
                await verifyLeadOwnership(
                    user.id,
                    leadId
                );

            if (!ownsLead) {

                return res.status(404).json({
                    error:
                        "Lead nicht gefunden."
                });
            }


            const response =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/lead_supply` +
                    `?user_id=eq.${encodeURIComponent(user.id)}` +
                    `&lead_id=eq.${encodeURIComponent(leadId)}`,
                    {
                        method:
                            "DELETE",

                        headers: {
                            ...serviceHeaders(),

                            Prefer:
                                "return=representation"
                        }
                    }
                );


            const text =
                await response.text();


            if (!response.ok) {

                throw new Error(
                    text ||
                    "Belieferung konnte nicht gelöscht werden."
                );
            }


            return res.status(200).json({
                success:
                    true
            });
        }


        return res.status(405).json({
            error:
                "Method Not Allowed"
        });


    } catch (error) {

        console.error(
            "Lead supply API error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Belieferungsdaten konnten nicht verarbeitet werden."
        });
    }
}