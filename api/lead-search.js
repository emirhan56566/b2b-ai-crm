// api/lead-search.js

import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";

const supabaseAuth = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

async function authenticate(req) {
    const authorization =
        req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
        return {
            user: null,
            error: "Nicht authentifiziert."
        };
    }

    const token =
        authorization.substring(7).trim();

    if (!token) {
        return {
            user: null,
            error: "Kein Access Token vorhanden."
        };
    }

    const {
        data,
        error
    } = await supabaseAuth.auth.getUser(token);

    if (error || !data?.user) {
        return {
            user: null,
            error: "Ungültige oder abgelaufene Sitzung."
        };
    }

    return {
        user: data.user,
        error: null
    };
}

function clean(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim();
}

function normalize(value) {
    return clean(value)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function safeInteger(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.round(number);
}

export default async function handler(req, res) {
    let searchId = null;

    try {
        // ==========================================
        // Nur POST erlauben
        // ==========================================

        if (req.method !== "POST") {
            return res.status(405).json({
                success: false,
                error: "Method not allowed"
            });
        }

        // ==========================================
        // Benutzer authentifizieren
        // ==========================================

        const {
            user,
            error: authError
        } = await authenticate(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                error: authError || "Nicht authentifiziert."
            });
        }

        // ==========================================
        // Request lesen
        // ==========================================

        const body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body || {};

        const industry =
            clean(body.industry);

        const postal =
            clean(body.postal);

        const radiusKm =
            safeInteger(
                body.radius_km,
                25
            );

        const employeesFrom =
            body.mitarbeiter_von === ""
                ? null
                : safeInteger(
                    body.mitarbeiter_von,
                    null
                );

        const employeesTo =
            body.mitarbeiter_bis === ""
                ? null
                : safeInteger(
                    body.mitarbeiter_bis,
                    null
                );

        const amount =
            Math.min(
                Math.max(
                    safeInteger(
                        body.anzahl,
                        50
                    ),
                    1
                ),
                100
            );

        const additionalCriteria =
            clean(
                body.zusatzkriterien
            );

        const exclusionCriteria =
            clean(
                body.ausschlusskriterien
            );

        // ==========================================
        // Pflichtfelder
        // ==========================================

        if (!industry) {
            return res.status(400).json({
                success: false,
                error: "Branche fehlt."
            });
        }

        if (!postal) {
            return res.status(400).json({
                success: false,
                error: "Postleitzahl fehlt."
            });
        }

        if (radiusKm < 1 || radiusKm > 500) {
            return res.status(400).json({
                success: false,
                error:
                    "Der Radius muss zwischen 1 und 500 km liegen."
            });
        }

        // ==========================================
        // Suchauftrag speichern
        // ==========================================

        const {
            data: search,
            error: searchInsertError
        } = await supabase
            .from("lead_searches")
            .insert({
                user_id: user.id,
                status: "running",
                industry,
                postal_code: postal,
                radius_km: radiusKm,
                employees_from: employeesFrom,
                employees_to: employeesTo,
                amount_requested: amount,
                additional_criteria:
                    additionalCriteria || null,
                exclusion_criteria:
                    exclusionCriteria || null
            })
            .select()
            .single();

        if (searchInsertError) {
            console.error(
                "Lead search insert error:",
                searchInsertError
            );

            return res.status(500).json({
                success: false,
                error:
                    "Suchauftrag konnte nicht gespeichert werden."
            });
        }

        searchId = search.id;

        // ==========================================
        // Bereits vorhandene Firmen laden
        // ==========================================

        const {
            data: existingCompanies,
            error: existingCompaniesError
        } = await supabase
            .from("companies")
            .select(`
                id,
                name,
                website,
                phone,
                postal_code,
                city
            `)
            .eq("user_id", user.id)
            .limit(5000);

        if (existingCompaniesError) {
            throw new Error(
                existingCompaniesError.message
            );
        }

        const existingCompanyKeys =
            new Set(
                (existingCompanies || [])
                    .map((company) => {
                        return [
                            normalize(company.name),
                            normalize(company.website)
                        ]
                            .filter(Boolean)
                            .join("|");
                    })
                    .filter(Boolean)
            );

        // ==========================================
        // Master Prompt
        // ==========================================

        const systemPrompt = `
Du bist die Lead-Recherche-KI eines professionellen
B2B-CRMs.

Deine Aufgabe ist es, reale Unternehmen im Internet
zu recherchieren und strukturierte B2B-Leads zu liefern.

WICHTIGE REGELN:

1. Erfinde niemals Unternehmen.
2. Erfinde niemals Telefonnummern.
3. Erfinde niemals E-Mail-Adressen.
4. Erfinde niemals Webseiten.
5. Wenn eine Information nicht verifiziert werden kann,
   setze sie auf null.
6. Verwende bevorzugt offizielle Unternehmenswebseiten
   und andere seriöse öffentliche Quellen.
7. Ein Unternehmen darf nur aufgenommen werden, wenn
   es tatsächlich existiert und die Recherche dafür
   ausreichende Belege liefert.
8. Keine Duplikate.
9. Keine offensichtlich geschlossenen Unternehmen.
10. Keine Unternehmen, die ausdrücklich ausgeschlossen
    wurden.
11. Private Personen ohne klaren geschäftlichen Bezug
    sind keine Leads.
12. Keine erfundenen Mitarbeiterzahlen.
13. Mitarbeiterzahlen dürfen nur angegeben werden,
    wenn sie aus einer belastbaren öffentlichen Quelle
    hervorgehen.
14. Telefonnummern müssen möglichst direkt aus einer
    öffentlich zugänglichen Unternehmensquelle stammen.
15. Die Entfernung zum angegebenen Ausgangs-PLZ-Gebiet
    darf nicht als exakt behauptet werden, wenn keine
    belastbare geografische Prüfung möglich ist.
16. Wenn die Entfernung nicht verifiziert werden kann,
    setze distance_km auf null.
17. Liefere maximal die angeforderte Anzahl an Leads.
18. Qualität ist wichtiger als die Anzahl.
19. Verwende keine Suchmaschinen-Snippets als alleinige
    Grundlage, wenn eine bessere Primärquelle verfügbar ist.
20. Gib für jeden Lead mindestens eine überprüfbare
    öffentliche Quelle an.

ZIEL:

Finde Unternehmen, die möglichst genau zu den
angegebenen Suchkriterien passen.

Die Ergebnisse werden anschließend automatisch
in ein CRM übernommen.

Deshalb müssen die Daten strukturiert, sauber und
konservativ sein.
`;

        // ==========================================
        // Benutzer-Prompt
        // ==========================================

        const userPrompt = `
Suche reale B2B-Unternehmen anhand dieser Kriterien:

BRANCHE:
${industry}

AUSGANGS-PLZ:
${postal}

MAXIMALER RADIUS:
${radiusKm} km

MITARBEITER VON:
${employeesFrom ?? "keine Vorgabe"}

MITARBEITER BIS:
${employeesTo ?? "keine Vorgabe"}

GEWÜNSCHTE ANZAHL:
${amount}

ZUSÄTZLICHE KRITERIEN:
${additionalCriteria || "keine"}

AUSSCHLUSSKRITERIEN:
${exclusionCriteria || "keine"}

BEREITS IM CRM VORHANDENE UNTERNEHMEN:
${JSON.stringify(
    existingCompanies || []
)}

Versuche, neue Unternehmen zu finden, die noch nicht
im CRM vorhanden sind.

Wenn ein Unternehmen bereits anhand von Name oder
Webseite eindeutig vorhanden ist, überspringe es.

Suche gründlich im Internet.

Gib nur Unternehmen zurück, deren Existenz und
geschäftliche Tätigkeit ausreichend überprüfbar sind.
`;

        // ==========================================
        // OpenAI prüfen
        // ==========================================

        if (!process.env.OPENAI_API_KEY) {
            throw new Error(
                "OPENAI_API_KEY fehlt."
            );
        }

        const model =
            process.env.OPENAI_MODEL ||
            "gpt-5.6-luna";

        // ==========================================
        // OpenAI Responses API
        // ==========================================

        const openaiResponse =
            await fetch(
                "https://api.openai.com/v1/responses",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Authorization":
                            `Bearer ${process.env.OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model,

                        tools: [
                            {
                                type: "web_search"
                            }
                        ],

                        input: [
                            {
                                role: "system",
                                content: systemPrompt
                            },
                            {
                                role: "user",
                                content: userPrompt
                            }
                        ],

                        text: {
                            format: {
                                type: "json_schema",
                                name: "b2b_leads",
                                strict: true,
                                schema: {
                                    type: "object",
                                    additionalProperties: false,
                                    properties: {
                                        leads: {
                                            type: "array",
                                            items: {
                                                type: "object",
                                                additionalProperties:
                                                    false,
                                                properties: {
                                                    company_name: {
                                                        type: "string"
                                                    },
                                                    legal_name: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    industry: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    website: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    phone: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    email: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    address: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    postal_code: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    city: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    country: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    employee_count: {
                                                        type: [
                                                            "integer",
                                                            "null"
                                                        ]
                                                    },
                                                    distance_km: {
                                                        type: [
                                                            "number",
                                                            "null"
                                                        ]
                                                    },
                                                    description: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    source_url: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    },
                                                    source_name: {
                                                        type: [
                                                            "string",
                                                            "null"
                                                        ]
                                                    }
                                                },
                                                required: [
                                                    "company_name",
                                                    "legal_name",
                                                    "industry",
                                                    "website",
                                                    "phone",
                                                    "email",
                                                    "address",
                                                    "postal_code",
                                                    "city",
                                                    "country",
                                                    "employee_count",
                                                    "distance_km",
                                                    "description",
                                                    "source_url",
                                                    "source_name"
                                                ]
                                            }
                                        }
                                    },
                                    required: [
                                        "leads"
                                    ]
                                }
                            }
                        }
                    })
                }
            );

        // ==========================================
        // OpenAI Fehler
        // ==========================================

        if (!openaiResponse.ok) {
            const errorText =
                await openaiResponse.text();

            console.error(
                "OpenAI API error:",
                errorText
            );

            throw new Error(
                `OpenAI API Fehler: ${errorText}`
            );
        }

        const aiResult =
            await openaiResponse.json();

        // ==========================================
        // JSON-Ausgabe extrahieren
        // ==========================================

        let parsed;

        if (aiResult.output_text) {
            parsed =
                JSON.parse(
                    aiResult.output_text
                );
        } else {
            const textParts = [];

            for (
                const outputItem
                of aiResult.output || []
            ) {
                for (
                    const contentItem
                    of outputItem.content || []
                ) {
                    if (
                        contentItem.type ===
                        "output_text"
                    ) {
                        textParts.push(
                            contentItem.text
                        );
                    }
                }
            }

            if (!textParts.length) {
                throw new Error(
                    "Die KI hat keine verwertbare Antwort geliefert."
                );
            }

            parsed =
                JSON.parse(
                    textParts.join("")
                );
        }

        const aiLeads =
            Array.isArray(parsed?.leads)
                ? parsed.leads
                : [];

        // ==========================================
        // Ergebnisse bereinigen + Duplikate entfernen
        // ==========================================

        const uniqueLeads = [];
        const seen = new Set();

        for (const item of aiLeads) {
            const companyName =
                clean(item.company_name);

            if (!companyName) {
                continue;
            }

            const website =
                clean(item.website);

            const key =
                [
                    normalize(companyName),
                    normalize(website)
                ]
                    .filter(Boolean)
                    .join("|");

            if (!key) {
                continue;
            }

            if (
                seen.has(key) ||
                existingCompanyKeys.has(key)
            ) {
                continue;
            }

            seen.add(key);

            uniqueLeads.push({
                ...item,
                company_name:
                    companyName,
                website:
                    website || null,
                phone:
                    clean(item.phone) || null,
                email:
                    clean(item.email) || null,
                address:
                    clean(item.address) || null,
                postal_code:
                    clean(item.postal_code) || null,
                city:
                    clean(item.city) || null,
                country:
                    clean(item.country) ||
                    "Deutschland",
                source_url:
                    clean(item.source_url) ||
                    null,
                source_name:
                    clean(item.source_name) ||
                    null
            });

            if (
                uniqueLeads.length >= amount
            ) {
                break;
            }
        }

        // ==========================================
        // Leads speichern
        // ==========================================

        const savedLeads = [];

        for (const item of uniqueLeads) {
            // --------------------------------------
            // Unternehmen
            // --------------------------------------

            const {
                data: company,
                error: companyError
            } = await supabase
                .from("companies")
                .insert({
                    user_id: user.id,
                    name:
                        item.company_name,
                    legal_name:
                        item.legal_name || null,
                    industry:
                        item.industry ||
                        industry,
                    website:
                        item.website,
                    phone:
                        item.phone,
                    email:
                        item.email,
                    address:
                        item.address,
                    postal_code:
                        item.postal_code,
                    city:
                        item.city,
                    country:
                        item.country ||
                        "Deutschland",
                    employee_count:
                        item.employee_count ??
                        null
                })
                .select()
                .single();

            if (companyError) {
                console.error(
                    "Company save error:",
                    companyError
                );

                continue;
            }

            // --------------------------------------
            // Lead
            // --------------------------------------

            const {
                data: lead,
                error: leadError
            } = await supabase
                .from("leads")
                .insert({
                    user_id: user.id,
                    company_id:
                        company.id,
                    status: "new",
                    priority: "normal",
                    score: null,
                    notes:
                        item.description ||
                        null,
                    assigned_to:
                        user.id
                })
                .select()
                .single();

            if (leadError) {
                console.error(
                    "Lead save error:",
                    leadError
                );

                // Unternehmen wieder entfernen,
                // wenn der Lead nicht erstellt wurde.
                await supabase
                    .from("companies")
                    .delete()
                    .eq("id", company.id)
                    .eq("user_id", user.id);

                continue;
            }

            // --------------------------------------
            // Quelle speichern
            // --------------------------------------

            if (item.source_url) {
                const {
                    error: sourceError
                } = await supabase
                    .from("lead_sources")
                    .insert({
                        user_id: user.id,
                        lead_id:
                            lead.id,
                        company_id:
                            company.id,
                        source_url:
                            item.source_url,
                        source_name:
                            item.source_name ||
                            null
                    });

                if (sourceError) {
                    console.error(
                        "Source save error:",
                        sourceError
                    );
                }
            }

            // --------------------------------------
            // Aktivität speichern
            // --------------------------------------

            await supabase
                .from("activities")
                .insert({
                    user_id: user.id,
                    lead_id:
                        lead.id,
                    company_id:
                        company.id,
                    type:
                        "lead_created",
                    subject:
                        "Lead durch KI-Recherche erstellt",
                    description:
                        `Unternehmen wurde durch die KI-Lead-Suche gefunden. Suchauftrag: ${searchId}`
                });

            savedLeads.push({
                ...lead,
                company
            });
        }

        // ==========================================
        // Suchauftrag abschließen
        // ==========================================

        await supabase
            .from("lead_searches")
            .update({
                status: "completed",
                results_count:
                    savedLeads.length,
                completed_at:
                    new Date().toISOString()
            })
            .eq("id", searchId)
            .eq("user_id", user.id);

        // ==========================================
        // Antwort
        // ==========================================

        return res.status(200).json({
            success: true,
            search_id: searchId,
            requested: amount,
            found:
                aiLeads.length,
            saved:
                savedLeads.length,
            leads:
                savedLeads
        });

    } catch (error) {
        console.error(
            "Lead search error:",
            error
        );

        // Suchauftrag auf Fehler setzen
        if (searchId) {
            try {
                await supabase
                    .from("lead_searches")
                    .update({
                        status: "failed",
                        error_message:
                            error.message ||
                            "Unbekannter Fehler",
                        completed_at:
                            new Date().toISOString()
                    })
                    .eq("id", searchId);
            } catch (updateError) {
                console.error(
                    "Could not update search status:",
                    updateError
                );
            }
        }

        return res.status(500).json({
            success: false,
            error:
                error.message ||
                "Die Lead-Suche ist fehlgeschlagen."
        });
    }
}