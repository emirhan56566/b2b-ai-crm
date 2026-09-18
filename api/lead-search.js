import { supabase } from "./supabase.js";

/*
 * B2B AI CRM – KI Lead-Suche
 *
 * Funktionen:
 * - Authentifizierung über Supabase Access Token
 * - Gemini Interactions API
 * - Google Search für aktuelle Unternehmensrecherche
 * - Automatischer Modell-Fallback
 * - Strukturierte JSON-Ausgabe
 * - Duplikatprüfung
 * - Speicherung in companies / contacts / leads / lead_sources / activities
 * - Speicherung der Suchhistorie in lead_searches
 *
 * Keine zusätzliche npm-Abhängigkeit notwendig.
 */

const MODEL_FALLBACKS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const MAX_RESULTS = 100;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Nur POST ist erlaubt.",
    });
  }

  let searchId = null;

  try {
    // ------------------------------------------------------------
    // 1. ENV prüfen
    // ------------------------------------------------------------

    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY fehlt in den Vercel Environment Variables.");
    }

    if (!process.env.SUPABASE_URL) {
      throw new Error("SUPABASE_URL fehlt.");
    }

    if (!process.env.SUPABASE_ANON_KEY) {
      throw new Error("SUPABASE_ANON_KEY fehlt.");
    }

    // ------------------------------------------------------------
    // 2. Benutzer authentifizieren
    // ------------------------------------------------------------

    const auth = await authenticate(req);

    if (!auth.user) {
      return res.status(401).json({
        success: false,
        error: auth.error || "Nicht authentifiziert.",
      });
    }

    const userId = auth.user.id;

    // ------------------------------------------------------------
    // 3. Request-Daten lesen
    // ------------------------------------------------------------

    const body = req.body || {};

    const industry = cleanString(
      body.industry ||
      body.branche ||
      body.industryName
    );

    const postalCode = cleanString(
      body.postal_code ||
      body.postalCode ||
      body.plz
    );

    const radiusKm = toInteger(
      body.radius_km ??
      body.radiusKm ??
      body.radius
    );

    const employeesFrom = toInteger(
      body.employees_from ??
      body.employeesFrom ??
      body.mitarbeiter_von
    );

    const employeesTo = toInteger(
      body.employees_to ??
      body.employeesTo ??
      body.mitarbeiter_bis
    );

    const requestedCount = clamp(
      toInteger(
        body.requested_count ??
        body.requestedCount ??
        body.amount_requested ??
        body.amountRequested ??
        body.anzahl
      ) || 50,
      1,
      MAX_RESULTS
    );

    const additionalCriteria = cleanString(
      body.additional_criteria ||
      body.additionalCriteria ||
      body.zusatzkriterien
    );

    const exclusionCriteria = cleanString(
      body.exclusion_criteria ||
      body.exclusionCriteria ||
      body.ausschlusskriterien
    );

    if (!industry && !postalCode && !additionalCriteria) {
      return res.status(400).json({
        success: false,
        error: "Bitte mindestens Branche, PLZ oder zusätzliche Kriterien angeben.",
      });
    }

    // ------------------------------------------------------------
    // 4. Suchanfrage erzeugen
    // ------------------------------------------------------------

    const query = buildSearchQuery({
      industry,
      postalCode,
      radiusKm,
      employeesFrom,
      employeesTo,
      requestedCount,
      additionalCriteria,
      exclusionCriteria,
    });

    // ------------------------------------------------------------
    // 5. Suchlauf speichern
    // ------------------------------------------------------------

    const searchInsert = await supabase
      .from("lead_searches")
      .insert({
        user_id: userId,
        query,
        industry: industry || null,
        postal_code: postalCode || null,
        radius_km: radiusKm || null,
        employees_from: employeesFrom || null,
        employees_to: employeesTo || null,
        requested_count: requestedCount,
        amount_requested: requestedCount,
        additional_criteria: additionalCriteria || null,
        exclusion_criteria: exclusionCriteria || null,
        status: "running",
        results_count: 0,
      });

    if (searchInsert.error) {
      throw new Error(
        `Lead-Suche konnte nicht gespeichert werden: ${searchInsert.error.message}`
      );
    }

    searchId = searchInsert.data?.id || null;

    // ------------------------------------------------------------
    // 6. Bestehende Unternehmen laden
    // ------------------------------------------------------------

    const existingCompaniesResult = await supabase
      .from("companies")
      .select("id,name,phone,website,address,postal_code,city,industry,employees")
      .eq("user_id", userId)
      .limit(5000);

    if (existingCompaniesResult.error) {
      throw new Error(
        `Bestehende Unternehmen konnten nicht geladen werden: ${existingCompaniesResult.error.message}`
      );
    }

    const existingCompanies = existingCompaniesResult.data || [];

    // ------------------------------------------------------------
    // 7. Gemini Prompt
    // ------------------------------------------------------------

    const prompt = buildResearchPrompt({
      industry,
      postalCode,
      radiusKm,
      employeesFrom,
      employeesTo,
      requestedCount,
      additionalCriteria,
      exclusionCriteria,
    });

    // ------------------------------------------------------------
    // 8. Gemini mit automatischem Fallback aufrufen
    // ------------------------------------------------------------

    const aiResult = await runGeminiWithFallback(prompt);

    const companies = normalizeCompanies(aiResult.companies);

    if (!companies.length) {
      await updateSearch(searchId, {
        status: "completed",
        results_count: 0,
        completed_at: new Date().toISOString(),
      });

      return res.status(200).json({
        success: true,
        search_id: searchId,
        model: aiResult.model,
        companies: [],
        results_count: 0,
        message: "Keine passenden Unternehmen gefunden.",
      });
    }

    // ------------------------------------------------------------
    // 9. Duplikate entfernen
    // ------------------------------------------------------------

    const deduplicated = deduplicateCompanies(
      companies,
      existingCompanies
    );

    // ------------------------------------------------------------
    // 10. Unternehmen / Kontakte / Leads speichern
    // ------------------------------------------------------------

    const savedCompanies = [];
    const skippedCompanies = [];

    for (const company of deduplicated) {
      try {
        const companyKey = createCompanyKey(company);

        const existing = existingCompanies.find(
          (existingCompany) =>
            createCompanyKey(existingCompany) === companyKey
        );

        let companyId = existing?.id || null;

        // --------------------------------------------
        // Unternehmen anlegen
        // --------------------------------------------

        if (!companyId) {
          const companyInsert = await supabase
            .from("companies")
            .insert({
              user_id: userId,
              name: company.name,
              phone: company.phone || null,
              email: company.email || null,
              website: company.website || null,
              address: company.address || null,
              postal_code: company.postal_code || null,
              city: company.city || null,
              country: company.country || "Deutschland",
              industry: company.industry || industry || null,
              employees: company.employees || null,
              description: company.description || null,
              status: "new",
            });

          if (companyInsert.error) {
            skippedCompanies.push({
              name: company.name,
              reason: companyInsert.error.message,
            });
            continue;
          }

          companyId = companyInsert.data?.id || null;
        }

        if (!companyId) {
          skippedCompanies.push({
            name: company.name,
            reason: "Unternehmen konnte nicht angelegt werden.",
          });
          continue;
        }

        // --------------------------------------------
        // Kontakt anlegen, wenn vorhanden
        // --------------------------------------------

        let contactId = null;

        if (
          company.contact &&
          (
            company.contact.first_name ||
            company.contact.last_name ||
            company.contact.email ||
            company.contact.phone
          )
        ) {
          const contactInsert = await supabase
            .from("contacts")
            .insert({
              user_id: userId,
              company_id: companyId,
              first_name: company.contact.first_name || null,
              last_name: company.contact.last_name || null,
              job_title: company.contact.job_title || null,
              email: company.contact.email || null,
              phone: company.contact.phone || null,
              mobile: company.contact.mobile || null,
            });

          if (!contactInsert.error) {
            contactId = contactInsert.data?.id || null;
          }
        }

        // --------------------------------------------
        // Lead anlegen
        // --------------------------------------------

        const leadInsert = await supabase
          .from("leads")
          .insert({
            user_id: userId,
            company_id: companyId,
            contact_id: contactId,
            status: "new",
            priority: calculatePriority(company),
            source: "ai_lead_search",
            notes: buildLeadNotes(company, aiResult.model),
          });

        if (leadInsert.error) {
          skippedCompanies.push({
            name: company.name,
            reason: leadInsert.error.message,
          });
          continue;
        }

        const leadId = leadInsert.data?.id || null;

        // --------------------------------------------
        // Quelle speichern
        // --------------------------------------------

        if (leadId && Array.isArray(company.sources)) {
          for (const source of company.sources.slice(0, 10)) {
            if (!source?.url) continue;

            await supabase
              .from("lead_sources")
              .insert({
                user_id: userId,
                lead_id: leadId,
                source_url: source.url,
                source_name: source.name || null,
              });
          }
        }

        // --------------------------------------------
        // Aktivität speichern
        // --------------------------------------------

        await supabase
          .from("activities")
          .insert({
            user_id: userId,
            company_id: companyId,
            contact_id: contactId,
            lead_id: leadId,
            type: "ai_lead_search",
            title: "Unternehmen durch KI-Lead-Suche gefunden",
            description:
              `Recherche mit ${aiResult.model}. ` +
              (company.reason || ""),
          });

        savedCompanies.push({
          id: companyId,
          lead_id: leadId,
          name: company.name,
          phone: company.phone || null,
          website: company.website || null,
          address: company.address || null,
          postal_code: company.postal_code || null,
          city: company.city || null,
          industry: company.industry || industry || null,
          employees: company.employees || null,
          contact: company.contact || null,
          sources: company.sources || [],
        });
      } catch (companyError) {
        skippedCompanies.push({
          name: company.name,
          reason: companyError.message,
        });
      }
    }

    // ------------------------------------------------------------
    // 11. Suchlauf aktualisieren
    // ------------------------------------------------------------

    await updateSearch(searchId, {
      status: "completed",
      results_count: savedCompanies.length,
      completed_at: new Date().toISOString(),
    });

    // ------------------------------------------------------------
    // 12. Ergebnis zurückgeben
    // ------------------------------------------------------------

    return res.status(200).json({
      success: true,
      search_id: searchId,
      model: aiResult.model,
      attempted_models: aiResult.attemptedModels,
      companies: savedCompanies,
      results_count: savedCompanies.length,
      skipped_count: skippedCompanies.length,
      skipped: skippedCompanies,
    });
  } catch (error) {
    console.error("Lead Search Error:", error);

    if (searchId) {
      await updateSearch(searchId, {
        status: "failed",
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return res.status(500).json({
      success: false,
      error: error?.message || "Unbekannter Fehler bei der Lead-Suche.",
    });
  }
}

/* ============================================================
   AUTHENTIFIZIERUNG
   ============================================================ */

async function authenticate(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return {
      user: null,
      error: "Nicht authentifiziert.",
    };
  }

  const token = authorization.substring(7).trim();

  if (!token) {
    return {
      user: null,
      error: "Kein Access Token vorhanden.",
    };
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    return {
      user: null,
      error: "Ungültige oder abgelaufene Sitzung.",
    };
  }

  const user = await response.json();

  if (!user?.id) {
    return {
      user: null,
      error: "Benutzer konnte nicht ermittelt werden.",
    };
  }

  return {
    user,
    error: null,
  };
}

/* ============================================================
   GEMINI INTERACTIONS API + FALLBACK
   ============================================================ */

async function runGeminiWithFallback(prompt) {
  const attemptedModels = [];
  const errors = [];

  for (const model of MODEL_FALLBACKS) {
    attemptedModels.push(model);

    try {
      const result = await callGeminiInteraction(model, prompt);

      return {
        model,
        attemptedModels,
        companies: result.companies || [],
      };
    } catch (error) {
      console.error(`Gemini-Modell ${model} fehlgeschlagen:`, error);

      errors.push({
        model,
        error: error.message,
      });

      if (!shouldFallback(error)) {
        break;
      }
    }
  }

  const details = errors
    .map((item) => `${item.model}: ${item.error}`)
    .join(" | ");

  throw new Error(
    `Keines der konfigurierten Gemini-Modelle konnte die Recherche ausführen. ${details}`
  );
}

async function callGeminiInteraction(model, prompt) {
  const schema = {
    type: "object",
    properties: {
      companies: {
        type: "array",
        description: "Gefundene B2B-Unternehmen.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Offizieller Firmenname.",
            },
            phone: {
              type: "string",
            },
            email: {
              type: "string",
            },
            website: {
              type: "string",
            },
            address: {
              type: "string",
            },
            postal_code: {
              type: "string",
            },
            city: {
              type: "string",
            },
            country: {
              type: "string",
            },
            industry: {
              type: "string",
            },
            employees: {
              type: ["integer", "null"],
            },
            description: {
              type: "string",
            },
            reason: {
              type: "string",
              description:
                "Kurze Begründung, warum das Unternehmen die Suchkriterien erfüllt.",
            },
            contact: {
              type: ["object", "null"],
              properties: {
                first_name: {
                  type: "string",
                },
                last_name: {
                  type: "string",
                },
                job_title: {
                  type: "string",
                },
                email: {
                  type: "string",
                },
                phone: {
                  type: "string",
                },
                mobile: {
                  type: "string",
                },
              },
            },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                  },
                  url: {
                    type: "string",
                  },
                },
                required: ["url"],
              },
            },
          },
          required: [
            "name",
            "phone",
            "email",
            "website",
            "address",
            "postal_code",
            "city",
            "country",
            "industry",
            "employees",
            "description",
            "reason",
            "contact",
            "sources",
          ],
        },
      },
    },
    required: ["companies"],
  };

  const requestBody = {
    model,
    input: prompt,

    tools: [
      {
        type: "google_search",
      },
    ],

    response_format: {
      type: "text",
      mime_type: "application/json",
      schema,
    },

    generation_config: {
      max_output_tokens: 20000,
    },

    store: false,
  };

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify(requestBody),
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      raw ||
      `Gemini API HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.code = data?.error?.status || null;

    throw error;
  }

  if (data?.status === "failed") {
    const message =
      data?.error?.message ||
      data?.message ||
      "Gemini Interaction ist fehlgeschlagen.";

    throw new Error(message);
  }

  const text = extractInteractionText(data);

  if (!text) {
    throw new Error(
      "Gemini hat keine verwertbare Antwort zurückgegeben."
    );
  }

  const parsed = parseJsonResponse(text);

  if (!parsed || !Array.isArray(parsed.companies)) {
    throw new Error(
      "Gemini hat kein erwartetes Unternehmen-JSON zurückgegeben."
    );
  }

  return parsed;
}

/* ============================================================
   GEMINI RESPONSE AUSLESEN
   ============================================================ */

function extractInteractionText(data) {
  if (!data) return "";

  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  if (typeof data.output?.text === "string") {
    return data.output.text;
  }

  if (Array.isArray(data.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === "string") {
        return output.text;
      }

      if (Array.isArray(output?.content)) {
        for (const content of output.content) {
          if (typeof content?.text === "string") {
            return content.text;
          }
        }
      }
    }
  }

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (typeof item?.text === "string") {
        return item.text;
      }

      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (typeof content?.text === "string") {
            return content.text;
          }
        }
      }
    }
  }

  return "";
}

function parseJsonResponse(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw new Error(
      "Gemini-Antwort konnte nicht als JSON gelesen werden."
    );
  }
}

/* ============================================================
   FALLBACK-LOGIK
   ============================================================ */

function shouldFallback(error) {
  const status = Number(error?.status || 0);

  // Auth-/Konfigurationsfehler nicht mit anderen Modellen wiederholen.
  if (status === 400 || status === 401 || status === 403) {
    const message = String(error?.message || "").toLowerCase();

    const modelAvailabilityError =
      message.includes("model") &&
      (
        message.includes("not found") ||
        message.includes("not available") ||
        message.includes("unsupported") ||
        message.includes("unavailable") ||
        message.includes("no longer available")
      );

    return modelAvailabilityError;
  }

  // Rate Limit / Kapazität / Serverfehler:
  if (
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  ) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("capacity") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded") ||
    message.includes("model") &&
    (
      message.includes("not found") ||
      message.includes("not available") ||
      message.includes("unsupported")
    )
  );
}

/* ============================================================
   PROMPT
   ============================================================ */

function buildResearchPrompt({
  industry,
  postalCode,
  radiusKm,
  employeesFrom,
  employeesTo,
  requestedCount,
  additionalCriteria,
  exclusionCriteria,
}) {
  return `
Du bist ein professioneller B2B-Research-Agent für ein deutsches CRM.

AUFGABE:
Finde bis zu ${requestedCount} reale B2B-Unternehmen, die möglichst genau
den folgenden Kriterien entsprechen.

SUCHKRITERIEN:

Branche:
${industry || "Keine bestimmte Branche angegeben"}

PLZ:
${postalCode || "Keine PLZ angegeben"}

Radius:
${radiusKm ? `${radiusKm} km` : "Kein bestimmter Radius angegeben"}

Mitarbeiter von:
${employeesFrom ?? "keine Angabe"}

Mitarbeiter bis:
${employeesTo ?? "keine Angabe"}

Zusätzliche Kriterien:
${additionalCriteria || "Keine"}

Ausschlusskriterien:
${exclusionCriteria || "Keine"}

RECHERCHE-REGELN:

1. Verwende Google Search aktiv.
2. Suche nach real existierenden Unternehmen.
3. Bevorzuge offizielle Unternehmenswebsites und seriöse öffentliche Quellen.
4. Erfinde niemals Unternehmen.
5. Erfinde niemals Telefonnummern, E-Mail-Adressen, Websites oder Mitarbeiterzahlen.
6. Wenn eine Information nicht verlässlich gefunden werden kann, lasse sie leer.
7. Prüfe möglichst mehrere Quellen.
8. Unternehmen müssen die Suchkriterien tatsächlich erfüllen.
9. Keine Privatpersonen als Leads.
10. Keine Unternehmen aufnehmen, die ausdrücklich den Ausschlusskriterien entsprechen.
11. Vermeide Duplikate.
12. Gib möglichst die offizielle Firmenbezeichnung an.
13. Telefonnummern nur übernehmen, wenn sie öffentlich auffindbar und dem Unternehmen zuordenbar sind.
14. Bei Ansprechpartnern nur öffentlich auffindbare geschäftliche Informationen verwenden.
15. Keine privaten oder sensiblen personenbezogenen Daten sammeln.
16. Für jedes Unternehmen Quellen mit URL angeben.
17. Wenn weniger als ${requestedCount} qualifizierte Unternehmen gefunden werden,
    gib lieber weniger echte Unternehmen zurück als erfundene Unternehmen.

QUALITÄT:
Die Genauigkeit ist wichtiger als die Anzahl.
Ein Unternehmen darf nur zurückgegeben werden, wenn es ausreichend belastbare
Hinweise gibt, dass es die Suchkriterien erfüllt.

AUSGABE:
Gib ausschließlich das angeforderte strukturierte JSON zurück.
`.trim();
}

/* ============================================================
   NORMALISIERUNG
   ============================================================ */

function normalizeCompanies(companies) {
  if (!Array.isArray(companies)) {
    return [];
  }

  return companies
    .map((company) => {
      if (!company || typeof company !== "object") {
        return null;
      }

      const contact =
        company.contact &&
        typeof company.contact === "object"
          ? {
              first_name: cleanString(company.contact.first_name),
              last_name: cleanString(company.contact.last_name),
              job_title: cleanString(company.contact.job_title),
              email: cleanString(company.contact.email),
              phone: cleanString(company.contact.phone),
              mobile: cleanString(company.contact.mobile),
            }
          : null;

      const sources = Array.isArray(company.sources)
        ? company.sources
            .filter((source) => source?.url)
            .map((source) => ({
              name: cleanString(source.name),
              url: cleanString(source.url),
            }))
            .slice(0, 10)
        : [];

      return {
        name: cleanString(company.name),
        phone: cleanString(company.phone),
        email: cleanString(company.email),
        website: cleanString(company.website),
        address: cleanString(company.address),
        postal_code: cleanString(company.postal_code),
        city: cleanString(company.city),
        country: cleanString(company.country) || "Deutschland",
        industry: cleanString(company.industry),
        employees: toInteger(company.employees),
        description: cleanString(company.description),
        reason: cleanString(company.reason),
        contact,
        sources,
      };
    })
    .filter((company) => company?.name);
}

/* ============================================================
   DUPLIKATE
   ============================================================ */

function deduplicateCompanies(companies, existingCompanies) {
  const seen = new Set();

  const existingKeys = new Set(
    existingCompanies.map((company) =>
      createCompanyKey(company)
    )
  );

  return companies.filter((company) => {
    const key = createCompanyKey(company);

    if (!key) {
      return false;
    }

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    // Bestehende Unternehmen nicht erneut als Lead anlegen.
    if (existingKeys.has(key)) {
      return false;
    }

    return true;
  });
}

function createCompanyKey(company) {
  const name = normalizeKey(company?.name);

  if (name) {
    return name;
  }

  const website = normalizeKey(company?.website);

  if (website) {
    return website;
  }

  return "";
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/* ============================================================
   PRIORITÄT
   ============================================================ */

function calculatePriority(company) {
  let score = 0;

  if (company.phone) score += 2;
  if (company.website) score += 2;
  if (company.address) score += 1;
  if (company.employees) score += 1;
  if (company.contact?.email) score += 2;
  if (company.contact?.phone) score += 2;
  if (company.sources?.length) score += 1;

  if (score >= 7) return "high";
  if (score >= 4) return "normal";

  return "low";
}

/* ============================================================
   LEAD NOTIZEN
   ============================================================ */

function buildLeadNotes(company, model) {
  const parts = [];

  if (company.reason) {
    parts.push(`KI-Recherche: ${company.reason}`);
  }

  if (model) {
    parts.push(`Verwendetes Gemini-Modell: ${model}`);
  }

  if (company.sources?.length) {
    parts.push(
      `Quellen: ${company.sources
        .map((source) => source.url)
        .filter(Boolean)
        .join(", ")}`
    );
  }

  return parts.join("\n\n");
}

/* ============================================================
   SEARCH UPDATE
   ============================================================ */

async function updateSearch(searchId, data) {
  if (!searchId) {
    return;
  }

  const result = await supabase
    .from("lead_searches")
    .update(data)
    .eq("id", searchId);

  if (result.error) {
    console.error(
      "Lead-Suche konnte nicht aktualisiert werden:",
      result.error.message
    );
  }
}

/* ============================================================
   HILFSFUNKTIONEN
   ============================================================ */

function cleanString(value) {
  if (
    value === undefined ||
    value === null ||
    typeof value === "object"
  ) {
    return "";
  }

  return String(value).trim();
}

function toInteger(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.trunc(number);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildSearchQuery({
  industry,
  postalCode,
  radiusKm,
  employeesFrom,
  employeesTo,
  requestedCount,
  additionalCriteria,
  exclusionCriteria,
}) {
  return [
    industry && `Branche: ${industry}`,
    postalCode && `PLZ: ${postalCode}`,
    radiusKm && `Radius: ${radiusKm} km`,
    employeesFrom !== null &&
      employeesFrom !== undefined &&
      `Mitarbeiter ab: ${employeesFrom}`,
    employeesTo !== null &&
      employeesTo !== undefined &&
      `Mitarbeiter bis: ${employeesTo}`,
    `Anzahl: ${requestedCount}`,
    additionalCriteria &&
      `Zusatzkriterien: ${additionalCriteria}`,
    exclusionCriteria &&
      `Ausschlusskriterien: ${exclusionCriteria}`,
  ]
    .filter(Boolean)
    .join(" | ");
}