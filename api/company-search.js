// api/company-search.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY =
    process.env.SUPABASE_ANON_KEY;

function headers() {
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

function escapeLike(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/,/g, "\\,");
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({
            error: "Method Not Allowed"
        });
    }

    try {
        const user = await getUser(req);

        const {
            postal_code,
            industry,
            types,
            industries
        } = req.query;

        // ------------------------------------------
        // Branchen laden
        // ------------------------------------------

        if (industries === "1") {
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/companies?user_id=eq.${encodeURIComponent(
                    user.id
                )}&select=industry&industry=not.is.null`,
                {
                    headers: headers()
                }
            );

            if (!response.ok) {
                throw new Error(
                    "Branchen konnten nicht geladen werden."
                );
            }

            const rows =
                await response.json();

            const values = [
                ...new Set(
                    rows
                        .map(row =>
                            String(
                                row.industry || ""
                            ).trim()
                        )
                        .filter(Boolean)
                )
            ].sort(
                (a, b) =>
                    a.localeCompare(
                        b,
                        "de"
                    )
            );

            return res.status(200).json({
                industries: values
            });
        }

        if (!postal_code) {
            return res.status(400).json({
                error:
                    "Postleitzahl fehlt."
            });
        }

        if (!industry) {
            return res.status(400).json({
                error:
                    "Branche fehlt."
            });
        }

        // ------------------------------------------
        // Unternehmen laden
        // ------------------------------------------

        const params = new URLSearchParams();

        params.set(
            "user_id",
            `eq.${user.id}`
        );

        params.set(
            "postal_code",
            `eq.${escapeLike(postal_code)}`
        );

        params.set(
            "industry",
            `eq.${escapeLike(industry)}`
        );

        params.set(
            "select",
            "*"
        );

        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/companies?${params}`,
            {
                headers: headers()
            }
        );

        if (!response.ok) {
            const text =
                await response.text();

            throw new Error(
                text ||
                "Unternehmen konnten nicht geladen werden."
            );
        }

        const companies =
            await response.json();

        // ------------------------------------------
        // Unternehmensarten filtern
        // ------------------------------------------

        const selectedTypes =
            types
                ? String(types)
                    .split(",")
                    .map(x =>
                        x.trim()
                            .toLowerCase()
                    )
                    .filter(Boolean)
                : [];

        let filtered =
            companies;

        if (selectedTypes.length) {
            filtered =
                companies.filter(
                    company => {

                        const legalForm =
                            String(
                                company.legal_form ||
                                ""
                            ).toLowerCase();

                        const name =
                            String(
                                company.name ||
                                ""
                            ).toLowerCase();

                        const matches =
                            selectedTypes.some(
                                type => {

                                    if (
                                        type ===
                                        "ek"
                                    ) {
                                        return (
                                            legalForm.includes("e.k") ||
                                            name.includes(" e.k") ||
                                            name.endsWith("ek")
                                        );
                                    }

                                    if (
                                        type ===
                                        "einzelunternehmen"
                                    ) {
                                        return (
                                            legalForm.includes(
                                                "einzelunternehmen"
                                            )
                                        );
                                    }

                                    if (
                                        type ===
                                        "kleinstunternehmen"
                                    ) {
                                        const employees =
                                            Number(
                                                company.employees
                                            );

                                        return (
                                            Number.isFinite(
                                                employees
                                            ) &&
                                            employees <= 9
                                        );
                                    }

                                    return false;
                                }
                            );

                        return matches;
                    }
                );
        }

        // ------------------------------------------
        // Bereits vorhandene Leads ermitteln
        // ------------------------------------------

        const companyIds =
            filtered
                .map(company => company.id)
                .filter(Boolean);

        let existingLeadIds =
            new Set();

        if (companyIds.length) {
            const leadResponse =
                await fetch(
                    `${SUPABASE_URL}/rest/v1/leads?user_id=eq.${encodeURIComponent(
                        user.id
                    )}&select=company_id`,
                    {
                        headers: headers()
                    }
                );

            if (leadResponse.ok) {
                const leads =
                    await leadResponse.json();

                existingLeadIds =
                    new Set(
                        leads
                            .map(
                                lead =>
                                    lead.company_id
                            )
                            .filter(Boolean)
                    );
            }
        }

        const result =
            filtered.map(
                company => ({
                    ...company,
                    already_lead:
                        existingLeadIds.has(
                            company.id
                        )
                })
            );

        return res.status(200).json({
            companies: result
        });

    } catch (error) {
        console.error(
            "Company search error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Unternehmen konnten nicht gesucht werden."
        });
    }
}
