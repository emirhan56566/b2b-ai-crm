import { supabase } from "./supabase.js";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", ["POST"]);

        return res.status(405).json({
            success: false,
            error: "Method not allowed"
        });
    }

    let searchId = null;

    try {
        // =====================================================
        // 1. API KEY PRÜFEN
        // =====================================================

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({
                success: false,
                error: "OPENAI_API_KEY ist nicht konfiguriert."
            });
        }

        // =====================================================
        // 2. EINGABEN
        // =====================================================

        const {
            user_id,

            industry,
            postal,
            radius,

            employeesMin,
            employeesMax,

            leadCount,

            additionalCriteria,
            excludeCriteria
        } = req.body || {};

        // =====================================================
        // 3. VALIDIERUNG
        // =====================================================

        if (!user_id) {
            return res.status(400).json({
                success: false,
                error: "user_id ist erforderlich."
            });
        }

        if (!industry || !String(industry).trim()) {
            return res.status(400).json({
                success: false,
                error: "Branche ist erforderlich."
            });
        }

        if (!postal || !String(postal).trim()) {
            return res.status(400).json({
                success: false,
                error: "Postleitzahl ist erforderlich."
            });
        }

        const requestedCount = Math.min(
            Math.max(Number(leadCount) || 50, 1),
            100
        );

        const radiusKm = Number(radius) || 25;

        // =====================================================
        // 4. LEAD-SUCHE IN SUPABASE ANLEGEN
        // =====================================================

        const { data: searchRecord, error: searchError } =
            await supabase
                .from("lead_searches")
                .insert({
                    user_id,

                    industry: String(industry).trim(),
                    postal_code: String(postal).trim(),

                    radius_km: radiusKm,

                    employees_min:
                        employeesMin !== undefined &&
                        employeesMin !== ""
                            ? Number(employeesMin)
                            : null,

                    employees_max:
                        employeesMax !== undefined &&
                        employeesMax !== ""
                            ? Number(employeesMax)
                            : null,

                    requested_count: requestedCount,

                    additional_criteria:
                        additionalCriteria || null,

                    exclude_criteria:
                        excludeCriteria || null,

                    status: "running",

                    search_parameters: {
                        industry,
                        postal,
                        radius: radiusKm,
                        employeesMin,
                        employeesMax,
                        leadCount: requestedCount,
                        additionalCriteria,
                        excludeCriteria
                    },

                    started_at: new Date().toISOString()
                })
                .select()
                .single();

        if (searchError) {
            console.error(
                "Lead search record error:",
                searchError
            );

            return res.status(500).json({
                success: false,
                error: searchError.message
            });
        }

        searchId = searchRecord.id;

        // =====================================================
        // 5. BESTEHENDE FIRMEN LADEN
        // =====================================================
        // Diese werden an die KI übergeben, damit möglichst
        // keine bereits bekannten Firmen erneut gefunden werden.

        const { data: existingCompanies } = await supabase
            .from("companies")
            .select(
                "name, postal_code, city, website, phone"
            )
            .eq("user_id", user_id)
            .limit(1000);

        const existingCompanyText =
            (existingCompanies || [])
                .map((company) => {
                    return [
                        company.name,
                        company.postal_code,
                        company.city,
                        company.website
                    ]
                        .filter(Boolean)
                        .join(" | ");
                })
                .join("\n");

        // =====================================================
        // 6. MASTER PROMPT
        // =====================================================
        //
        // WICHTIG:
        // Dieser Prompt ist zunächst eine belastbare technische
        // Version. Die endgültige Version bauen wir später
        // exakt nach deinen Lead-Suchregeln.
        //

        const systemPrompt = `
Du bist ein professioneller B2B Lead Research Agent.

Deine Aufgabe ist es, reale Unternehmen im Internet zu
recherchieren und ausschließlich Unternehmen zurückzugeben,
die anhand öffentlich verfügbarer Informationen plausibel
verifiziert werden können.

ZIEL:
Finde B2B-Unternehmen entsprechend den Suchkriterien.

SUCHKRITERIEN:

Branche:
${industry}

Ausgangs-Postleitzahl:
${postal}

Maximaler Radius:
${radiusKm} km

Mitarbeiter von:
${employeesMin || "nicht angegeben"}

Mitarbeiter bis:
${employeesMax || "nicht angegeben"}

Gewünschte Anzahl:
${requestedCount}

Zusätzliche Kriterien:
${additionalCriteria || "keine"}

Ausschlusskriterien:
${excludeCriteria || "keine"}

ABSOLUT WICHTIGE REGELN:

1. Erfinde niemals Unternehmen.

2. Erfinde niemals Telefonnummern.

3. Erfinde niemals Websites.

4. Erfinde niemals Adressen.

5. Erfinde niemals Mitarbeiterzahlen.

6. Verwende nur Informationen, die du durch Web-Recherche
   nachvollziehen kannst.

7. Bevorzuge offizielle Unternehmenswebsites.

8. Verwende zusätzlich seriöse Unternehmensverzeichnisse
   oder andere öffentlich zugängliche Quellen, wenn nötig.

9. Ein Unternehmen muss tatsächlich existieren.

10. Prüfe möglichst:
    - Unternehmensname
    - Branche
    - Adresse
    - Postleitzahl
    - Ort
    - Telefonnummer
    - Website
    - Mitarbeiterzahl, falls öffentlich belegbar

11. Telefonnummern dürfen nur eingetragen werden, wenn sie
    öffentlich gefunden und dem Unternehmen zugeordnet werden
    können.

12. Wenn eine Information nicht verifiziert werden kann,
    verwende null oder einen leeren Wert.

13. Keine erfundenen Kontaktdaten.

14. Keine privaten Telefonnummern oder privaten E-Mail-Adressen
    von Personen erfinden.

15. Suche ausschließlich nach Unternehmen, die für B2B-Vertrieb
    relevant sind.

16. Berücksichtige den angegebenen geografischen Radius.
    Wenn die Entfernung nicht ausreichend verifizierbar ist,
    soll das Unternehmen nicht aufgenommen werden.

17. Beachte die Ausschlusskriterien strikt.

18. Entferne Duplikate.

19. Bereits bekannte Unternehmen dürfen nicht erneut als neue
    Leads aufgenommen werden.

20. Die Qualität ist wichtiger als die Anzahl.
    Wenn weniger als die gewünschte Anzahl seriös verifizierbare
    Unternehmen gefunden werden, gib weniger zurück.

21. Gib niemals Platzhalter wie:
    "Beispiel GmbH",
    "Muster GmbH",
    "12345",
    "nicht bekannt"
    als echte Unternehmensdaten aus.

22. Die Daten müssen für ein CRM geeignet sein.

23. Gib ausschließlich das definierte JSON-Format zurück.

BEREITS BEKANNTE UNTERNEHMEN:

${existingCompanyText || "Keine bereits bekannten Unternehmen."}
`;

        // =====================================================
        // 7. STRUCTURED OUTPUT SCHEMA
        // =====================================================

        const leadSchema = {
            type: "object",

            additionalProperties: false,

            properties: {
                leads: {
                    type: "array",

                    items: {
                        type: "object",

                        additionalProperties: false,

                        properties: {
                            company_name: {
                                type: ["string", "null"]
                            },

                            legal_name: {
                                type: ["string", "null"]
                            },

                            industry: {
                                type: ["string", "null"]
                            },

                            phone: {
                                type: ["string", "null"]
                            },

                            email: {
                                type: ["string", "null"]
                            },

                            website: {
                                type: ["string", "null"]
                            },

                            street: {
                                type: ["string", "null"]
                            },

                            house_number: {
                                type: ["string", "null"]
                            },

                            postal_code: {
                                type: ["string", "null"]
                            },

                            city: {
                                type: ["string", "null"]
                            },

                            country: {
                                type: ["string", "null"]
                            },

                            employees: {
                                type: ["integer", "null"]
                            },

                            description: {
                                type: ["string", "null"]
                            },

                            source_url: {
                                type: ["string", "null"]
                            },

                            source_name: {
                                type: ["string", "null"]
                            },

                            verification_notes: {
                                type: ["string", "null"]
                            }
                        },

                        required: [
                            "company_name",
                            "legal_name",
                            "industry",
                            "phone",
                            "email",
                            "website",
                            "street",
                            "house_number",
                            "postal_code",
                            "city",
                            "country",
                            "employees",
                            "description",
                            "source_url",
                            "source_name",
                            "verification_notes"
                        ]
                    }
                }
            },

            required: ["leads"]
        };

        // =====================================================
        // 8. OPENAI WEB SEARCH
        // =====================================================

        const openaiResponse = await fetch(
            OPENAI_API_URL,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",

                    "Authorization":
                        `Bearer ${process.env.OPENAI_API_KEY}`
                },

                body: JSON.stringify({
                    model: OPENAI_MODEL,

                    tools: [
                        {
                            type: "web_search"
                        }
                    ],

                    tool_choice: {
                        type: "web_search"
                    },

                    instructions: systemPrompt,

                    input: `
Führe jetzt eine echte Web-Recherche durch.

Suche nach ungefähr ${requestedCount} passenden Unternehmen.

Nutze mehrere unterschiedliche Suchanfragen, wenn dies
notwendig ist.

Prüfe die gefundenen Unternehmen anhand öffentlich
verfügbarer Quellen.

Achte besonders auf:
- tatsächliche Existenz
- Branche
- Standort
- Entfernung
- Telefonnummer
- Website
- Unternehmensgröße
- Ausschlusskriterien
- Duplikate

Gib anschließend ausschließlich das geforderte JSON zurück.
`,

                    text: {
                        format: {
                            type: "json_schema",

                            name: "b2b_leads",

                            description:
                                "Verifizierte B2B-Unternehmen für ein CRM.",

                            strict: true,

                            schema: leadSchema
                        }
                    },

                    max_output_tokens: 20000
                })
            }
        );

        // =====================================================
        // 9. OPENAI FEHLER
        // =====================================================

        if (!openaiResponse.ok) {
            const errorText =
                await openaiResponse.text();

            console.error(
                "OpenAI API error:",
                errorText
            );

            await supabase
                .from("lead_searches")
                .update({
                    status: "failed",

                    error_message:
                        "OpenAI Web-Recherche fehlgeschlagen.",

                    completed_at:
                        new Date().toISOString()
                })
                .eq("id", searchId);

            return res.status(502).json({
                success: false,
                error:
                    "Die KI-Websuche konnte nicht ausgeführt werden.",
                details:
                    process.env.NODE_ENV === "development"
                        ? errorText
                        : undefined
            });
        }

        const openaiData =
            await openaiResponse.json();

        // =====================================================
        // 10. TEXT AUS RESPONSE HOLEN
        // =====================================================

        let outputText =
            openaiData.output_text || "";

        // Fallback für Responses-API-Ausgaben
        if (!outputText && Array.isArray(openaiData.output)) {
            for (const item of openaiData.output) {
                if (
                    item.type === "message" &&
                    Array.isArray(item.content)
                ) {
                    for (const content of item.content) {
                        if (
                            content.type === "output_text" &&
                            content.text
                        ) {
                            outputText += content.text;
                        }
                    }
                }
            }
        }

        if (!outputText) {
            throw new Error(
                "Die KI hat keine Lead-Daten zurückgegeben."
            );
        }

        // =====================================================
        // 11. JSON PARSEN
        // =====================================================

        let parsed;

        try {
            parsed = JSON.parse(outputText);
        } catch (jsonError) {
            console.error(
                "JSON parse error:",
                outputText
            );

            throw new Error(
                "Die KI-Antwort konnte nicht als JSON verarbeitet werden."
            );
        }

        const rawLeads =
            Array.isArray(parsed.leads)
                ? parsed.leads
                : [];

        // =====================================================
        // 12. DUPLIKATE INNERHALB DER SUCHE ENTFERNEN
        // =====================================================

        const seen = new Set();

        const leads = rawLeads.filter((lead) => {
            const key = [
                lead.company_name,
                lead.postal_code,
                lead.city,
                lead.website
            ]
                .filter(Boolean)
                .join("|")
                .toLowerCase()
                .trim();

            if (!key) {
                return false;
            }

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);

            return true;
        });

        // =====================================================
        // 13. MAXIMALE ANZAHL EINHALTEN
        // =====================================================

        const finalLeads =
            leads.slice(0, requestedCount);

        // =====================================================
        // 14. LEADS IN SUPABASE SPEICHERN
        // =====================================================

        const savedLeads = [];

        for (const lead of finalLeads) {
            if (!lead.company_name) {
                continue;
            }

            // -----------------------------------------------
            // Bestehende Firma prüfen
            // -----------------------------------------------

            let companyQuery =
                supabase
                    .from("companies")
                    .select("*")
                    .eq("user_id", user_id)
                    .ilike(
                        "name",
                        lead.company_name
                    )
                    .limit(1);

            const {
                data: existingMatches,
                error: existingError
            } = await companyQuery;

            if (existingError) {
                console.error(
                    "Company duplicate check error:",
                    existingError
                );

                continue;
            }

            let company =
                existingMatches?.[0] || null;

            // -----------------------------------------------
            // Firma erstellen
            // -----------------------------------------------

            if (!company) {
                const {
                    data: newCompany,
                    error: companyError
                } = await supabase
                    .from("companies")
                    .insert({
                        user_id,

                        name: lead.company_name,
                        legal_name:
                            lead.legal_name || null,

                        industry:
                            lead.industry || null,

                        phone:
                            lead.phone || null,

                        email:
                            lead.email || null,

                        website:
                            lead.website || null,

                        street:
                            lead.street || null,

                        house_number:
                            lead.house_number || null,

                        postal_code:
                            lead.postal_code || null,

                        city:
                            lead.city || null,

                        country:
                            lead.country ||
                            "Deutschland",

                        employees:
                            lead.employees !== null &&
                            lead.employees !== undefined
                                ? lead.employees
                                : null,

                        description:
                            lead.description || null,

                        source:
                            lead.source_name ||
                            "OpenAI Web Search",

                        source_url:
                            lead.source_url || null
                    })
                    .select()
                    .single();

                if (companyError) {
                    console.error(
                        "Company insert error:",
                        companyError
                    );

                    continue;
                }

                company = newCompany;
            }

            // -----------------------------------------------
            // Prüfen, ob bereits ein Lead existiert
            // -----------------------------------------------

            const {
                data: existingLeads
            } = await supabase
                .from("leads")
                .select("id")
                .eq("user_id", user_id)
                .eq("company_id", company.id)
                .limit(1);

            if (
                existingLeads &&
                existingLeads.length > 0
            ) {
                continue;
            }

            // -----------------------------------------------
            // Lead erstellen
            // -----------------------------------------------

            const {
                data: newLead,
                error: leadError
            } = await supabase
                .from("leads")
                .insert({
                    user_id,

                    company_id:
                        company.id,

                    status: "new",

                    priority: "normal",

                    notes:
                        lead.verification_notes ||
                        null
                })
                .select()
                .single();

            if (leadError) {
                console.error(
                    "Lead insert error:",
                    leadError
                );

                continue;
            }

            // -----------------------------------------------
            // Quelle speichern
            // -----------------------------------------------

            await supabase
                .from("lead_sources")
                .insert({
                    user_id,

                    lead_id:
                        newLead.id,

                    company_id:
                        company.id,

                    source_name:
                        lead.source_name ||
                        "OpenAI Web Search",

                    source_url:
                        lead.source_url ||
                        null,

                    source_type:
                        "web_search",

                    metadata: {
                        verification_notes:
                            lead.verification_notes ||
                            null
                    }
                });

            // -----------------------------------------------
            // Activity speichern
            // -----------------------------------------------

            await supabase
                .from("activities")
                .insert({
                    user_id,

                    lead_id:
                        newLead.id,

                    company_id:
                        company.id,

                    type:
                        "lead_created",

                    subject:
                        "Lead durch KI-Websuche gefunden",

                    description:
                        `Lead wurde durch die KI-Websuche gefunden: ${company.name}`,

                    metadata: {
                        source:
                            "OpenAI Web Search",

                        search_id:
                            searchId
                    }
                });

            savedLeads.push({
                ...newLead,

                company
            });
        }

        // =====================================================
        // 15. SUCHVORGANG AKTUALISIEREN
        // =====================================================

        await supabase
            .from("lead_searches")
            .update({
                status: "completed",

                results_count:
                    savedLeads.length,

                completed_at:
                    new Date().toISOString()
            })
            .eq("id", searchId);

        // =====================================================
        // 16. ERGEBNIS ZURÜCKGEBEN
        // =====================================================

        return res.status(200).json({
            success: true,

            search_id: searchId,

            count:
                savedLeads.length,

            leads:
                savedLeads,

            message:
                `${savedLeads.length} neue Leads wurden recherchiert und in Supabase gespeichert.`
        });

    } catch (error) {
        console.error(
            "Lead search error:",
            error
        );

        // Suchvorgang bei Fehler als failed markieren
        if (searchId) {
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
        }

        return res.status(500).json({
            success: false,

            error:
                error.message ||
                "Interner Serverfehler."
        });
    }
}