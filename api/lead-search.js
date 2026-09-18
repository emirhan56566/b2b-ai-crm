// api/lead-search.js

export default async function handler(req, res) {
    // Nur POST erlauben
    if (req.method !== "POST") {
        return res.status(405).json({
            success: false,
            error: "Method not allowed"
        });
    }

    try {
        const {
            industry,
            postal,
            radius,
            employeesMin,
            employeesMax,
            leadCount,
            additionalCriteria,
            excludeCriteria
        } = req.body || {};

        // Grundlegende Validierung
        if (!industry || !postal) {
            return res.status(400).json({
                success: false,
                error: "Branche und Postleitzahl sind erforderlich."
            });
        }

        /*
         * ==========================================
         * MASTER-PROMPT
         * ==========================================
         *
         * Diesen Prompt werden wir später gemeinsam
         * exakt nach deinen Vorgaben ausarbeiten.
         */

        const systemPrompt = `
Du bist ein professioneller B2B Lead Research Agent.

Deine Aufgabe ist es, Unternehmen anhand der vom
Benutzer angegebenen Kriterien zu recherchieren.

WICHTIGE REGELN:

1. Erfinde niemals Unternehmen.
2. Erfinde niemals Telefonnummern.
3. Erfinde niemals Adressen.
4. Verwende nur überprüfbare Informationen.
5. Entferne doppelte Unternehmen.
6. Unternehmen müssen tatsächlich existieren.
7. Prüfe die Branche.
8. Prüfe die geografische Lage.
9. Berücksichtige die gewünschte Unternehmensgröße.
10. Gib strukturierte Daten zurück.

Der Benutzer sucht:

Branche:
${industry}

Postleitzahl:
${postal}

Radius:
${radius || "nicht angegeben"}

Mitarbeiter von:
${employeesMin || "nicht angegeben"}

Mitarbeiter bis:
${employeesMax || "nicht angegeben"}

Gewünschte Anzahl:
${leadCount || 50}

Zusätzliche Kriterien:
${additionalCriteria || "keine"}

Ausschlusskriterien:
${excludeCriteria || "keine"}

Antworte ausschließlich mit strukturierten Lead-Daten.
`;

        /*
         * ==========================================
         * HIER WIRD SPÄTER DIE ECHTE KI ANGESCHLOSSEN
         * ==========================================
         *
         * Beispiel:
         *
         * const response = await fetch(
         *     "https://api.openai.com/v1/responses",
         *     {
         *         method: "POST",
         *         headers: {
         *             "Content-Type": "application/json",
         *             "Authorization":
         *                 `Bearer ${process.env.OPENAI_API_KEY}`
         *         },
         *         body: JSON.stringify(...)
         *     }
         * );
         *
         * Der API-Key darf NIEMALS in index.html stehen.
         */

        const demoLeads = [
            {
                company_name: `${industry} Beispiel GmbH`,
                phone: "",
                address: `${postal}`,
                postal_code: postal,
                industry: industry,
                website: "",
                employees: null,
                source: "AI Research",
                status: "Neu"
            }
        ];

        return res.status(200).json({
            success: true,

            search: {
                industry,
                postal,
                radius,
                employeesMin,
                employeesMax,
                leadCount,
                additionalCriteria,
                excludeCriteria
            },

            leads: demoLeads,

            message:
                "Lead-Suche wurde verarbeitet. Die echte Web-/KI-Recherche wird als nächster Schritt angeschlossen."
        });

    } catch (error) {

        console.error("Lead search error:", error);

        return res.status(500).json({
            success: false,
            error: "Interner Serverfehler."
        });
    }
}