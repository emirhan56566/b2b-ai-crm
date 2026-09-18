import { supabase } from "./supabase.js";

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview"
];

const MAX_RESULTS = 50;

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  return header.slice(7).trim();
}

function cleanString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function cleanInteger(value, fallback = null) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.round(number);
}

function firstRow(data) {
  if (Array.isArray(data)) {
    return data[0] || null;
  }

  return data || null;
}

function extractText(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(extractText)
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    const preferredKeys = [
      "text",
      "output_text",
      "content",
      "message",
      "output"
    ];

    for (const key of preferredKeys) {
      if (value[key]) {
        const result = extractText(value[key]);

        if (result) {
          return result;
        }
      }
    }

    for (const valuePart of Object.values(value)) {
      const result = extractText(valuePart);

      if (result) {
        return result;
      }
    }
  }

  return "";
}

function parseJsonFromText(text) {
  if (!text) {
    return null;
  }

  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Weiter unten versuchen wir JSON innerhalb des Textes zu finden.
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(
        cleaned.slice(firstBrace, lastBrace + 1)
      );
    } catch {
      // Kein gültiges Objekt.
    }
  }

  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");

  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(
        cleaned.slice(firstBracket, lastBracket + 1)
      );
    } catch {
      // Kein gültiges Array.
    }
  }

  return null;
}

function normalizeCompany(company) {
  if (!company || typeof company !== "object") {
    return null;
  }

  const name = cleanString(
    company.name ||
    company.company_name ||
    company.firma ||
    company.unternehmen
  );

  if (!name) {
    return null;
  }

  return {
    name,
    phone: cleanString(
      company.phone ||
      company.telefon ||
      company.phone_number
    ),
    website: cleanString(
      company.website ||
      company.url ||
      company.homepage
    ),
    street: cleanString(
      company.street ||
      company.strasse ||
      company.address_street
    ),
    postal_code: cleanString(
      company.postal_code ||
      company.plz ||
      company.zip
    ),
    city: cleanString(
      company.city ||
      company.ort
    ),
    country: cleanString(
      company.country ||
      company.land ||
      "Deutschland"
    ),
    industry: cleanString(
      company.industry ||
      company.branche
    ),
    employees: cleanInteger(
      company.employees ||
      company.employee_count ||
      company.mitarbeiter
    ),
    description: cleanString(
      company.description ||
      company.beschreibung
    ),
    source_url: cleanString(
      company.source_url ||
      company.source ||
      company.quelle
    )
  };
}

function normalizeCompanies(parsed) {
  let companies = [];

  if (Array.isArray(parsed)) {
    companies = parsed;
  } else if (parsed && Array.isArray(parsed.companies)) {
    companies = parsed.companies;
  } else if (parsed && Array.isArray(parsed.leads)) {
    companies = parsed.leads;
  } else if (parsed && Array.isArray(parsed.results)) {
    companies = parsed.results;
  } else if (parsed && Array.isArray(parsed.unternehmen)) {
    companies = parsed.unternehmen;
  }

  const normalized = companies
    .map(normalizeCompany)
    .filter(Boolean);

  const unique = [];
  const seen = new Set();

  for (const company of normalized) {
    const key = (
      company.website ||
      `${company.name}|${company.postal_code}|${company.city}`
    )
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(company);
    }
  }

  return unique.slice(0, MAX_RESULTS);
}

function buildResearchPrompt({
  industry,
  postalCode,
  radiusKm,
  employeesFrom,
  employeesTo,
  requestedCount,
  additionalCriteria,
  exclusionCriteria
}) {
  return `
Du bist eine professionelle B2B-Research-KI für ein deutsches CRM.

AUFGABE

Recherchiere reale Unternehmen in Deutschland und liefere passende B2B-Unternehmen.

SUCHKRITERIEN

Branche:
${industry || "Keine spezielle Branche angegeben"}

Postleitzahl:
${postalCode || "Keine PLZ angegeben"}

Suchradius:
${radiusKm || "Kein Radius angegeben"} km

Mitarbeiter von:
${employeesFrom ?? "keine Angabe"}

Mitarbeiter bis:
${employeesTo ?? "keine Angabe"}

Gewünschte Anzahl:
${requestedCount || 50}

Zusätzliche Kriterien:
${additionalCriteria || "Keine"}

Ausschlusskriterien:
${exclusionCriteria || "Keine"}

REGELN

1. Suche ausschließlich nach real existierenden Unternehmen.
2. Nutze aktuelle öffentlich zugängliche Informationen.
3. Nutze Google Search intensiv für die Recherche.
4. Erfinde niemals Unternehmen.
5. Erfinde niemals Telefonnummern.
6. Erfinde niemals Webseiten.
7. Wenn eine Information nicht zuverlässig gefunden wird, lasse sie leer.
8. Bevorzuge offizielle Unternehmenswebseiten.
9. Unternehmen müssen möglichst gut zu den Suchkriterien passen.
10. Keine Privatpersonen.
11. Keine erfundenen Ansprechpartner.
12. Keine erfundenen Mitarbeiterzahlen.
13. Keine Duplikate.
14. Gib maximal ${requestedCount || 50} Unternehmen zurück.
15. Wenn weniger Unternehmen zuverlässig gefunden werden können, gib nur die tatsächlich gefundenen zurück.

AUSGABE

Antworte ausschließlich mit gültigem JSON.

Format:

{
  "companies": [
    {
      "name": "Firmenname",
      "phone": "Telefonnummer oder leer",
      "website": "https://...",
      "street": "Straße und Hausnummer oder leer",
      "postal_code": "PLZ oder leer",
      "city": "Ort oder leer",
      "country": "Deutschland",
      "industry": "Branche oder leer",
      "employees": 0,
      "description": "Kurze sachliche Beschreibung",
      "source_url": "Quelle"
    }
  ]
}
`;
}

async function callGemini(model, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY ist in Vercel nicht gesetzt."
    );
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        model,
        input: prompt,
        tools: [
          {
            type: "google_search"
          }
        ],
        store: false
      })
    }
  );

  const raw = await response.text();

  let data = null;

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
      `HTTP ${response.status}`;

    const error = new Error(message);

    error.status = response.status;
    error.model = model;

    throw error;
  }

  const text = extractText(data);

  if (!text) {
    throw new Error(
      `Gemini ${model} hat keine verwertbare Antwort geliefert.`
    );
  }

  const parsed = parseJsonFromText(text);

  if (!parsed) {
    throw new Error(
      `Gemini ${model} hat kein gültiges JSON geliefert.`
    );
  }

  return {
    model,
    data,
    parsed,
    text
  };
}

async function callGeminiWithFallback(prompt) {
  const attemptedModels = [];
  const errors = [];

  for (const model of GEMINI_MODELS) {
    attemptedModels.push(model);

    try {
      console.log(
        `[lead-search] Gemini Versuch: ${model}`
      );

      const result = await callGemini(model, prompt);

      console.log(
        `[lead-search] Gemini erfolgreich: ${model}`
      );

      return {
        ...result,
        attemptedModels,
        errors
      };

    } catch (error) {
      const message =
        error?.message ||
        "Unbekannter Gemini-Fehler";

      console.error(
        `[lead-search] ${model} fehlgeschlagen: ${message}`
      );

      errors.push({
        model,
        status: error?.status || null,
        message
      });

      // Wichtig:
      // Nicht abbrechen.
      // Direkt das nächste Modell versuchen.
    }
  }

  const error = new Error(
    "Alle konfigurierten Gemini-Modelle sind fehlgeschlagen."
  );

  error.attemptedModels = attemptedModels;
  error.errors = errors;

  throw error;
}

async function getAuthenticatedUser(req) {
  const token = getBearerToken(req);

  if (!token) {
    return null;
  }

  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: process.env.SUPABASE_ANON_KEY
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const user = await response.json();

    if (!user?.id) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

async function findExistingCompany(userId, company) {
  if (!userId || !company?.name) {
    return null;
  }

  try {
    if (company.website) {
      const result = await supabase
        .from("companies")
        .select("*")
        .eq("user_id", userId)
        .eq("website", company.website)
        .limit(1);

      const existing = firstRow(result.data);

      if (existing) {
        return existing;
      }
    }

    const result = await supabase
      .from("companies")
      .select("*")
      .eq("user_id", userId)
      .eq("name", company.name)
      .limit(1);

    return firstRow(result.data);
  } catch (error) {
    console.error(
      "[lead-search] Fehler bei Duplikatprüfung:",
      error
    );

    return null;
  }
}

async function createCompany(userId, company) {
  const existing = await findExistingCompany(
    userId,
    company
  );

  if (existing) {
    return {
      company: existing,
      created: false
    };
  }

  const payload = {
    user_id: userId,
    name: company.name,
    phone: company.phone || null,
    website: company.website || null,
    street: company.street || null,
    postal_code: company.postal_code || null,
    city: company.city || null,
    country: company.country || "Deutschland",
    industry: company.industry || null,
    employees: company.employees || null,
    description: company.description || null
  };

  const result = await supabase
    .from("companies")
    .insert(payload);

  if (result.error) {
    throw new Error(
      `Unternehmen konnte nicht gespeichert werden: ${result.error.message}`
    );
  }

  return {
    company: firstRow(result.data),
    created: true
  };
}

async function createLead(userId, companyId, searchId) {
  if (!companyId) {
    return null;
  }

  try {
    const existingResult = await supabase
      .from("leads")
      .select("*")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .limit(1);

    const existing = firstRow(existingResult.data);

    if (existing) {
      return existing;
    }

    const result = await supabase
      .from("leads")
      .insert({
        user_id: userId,
        company_id: companyId,
        status: "new",
        source: "ai_lead_search",
        lead_search_id: searchId || null
      });

    if (result.error) {
      throw new Error(
        `Lead konnte nicht gespeichert werden: ${result.error.message}`
      );
    }

    return firstRow(result.data);
  } catch (error) {
    console.error(
      "[lead-search] Lead konnte nicht erstellt werden:",
      error
    );

    return null;
  }
}

async function createLeadSource(
  userId,
  companyId,
  searchId,
  company
) {
  if (!companyId) {
    return;
  }

  try {
    await supabase
      .from("lead_sources")
      .insert({
        user_id: userId,
        company_id: companyId,
        lead_search_id: searchId || null,
        source_type: "google_search",
        source_url: company.source_url || company.website || null
      });
  } catch (error) {
    console.error(
      "[lead-search] lead_sources Fehler:",
      error
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({
      error: "Method not allowed"
    });

    return;
  }

  try {
    const user = await getAuthenticatedUser(req);

    if (!user?.id) {
      res.status(401).json({
        error: "Nicht authentifiziert."
      });

      return;
    }

    const body = req.body || {};

    const industry = cleanString(
      body.industry ||
      body.branche
    );

    const postalCode = cleanString(
      body.postal_code ||
      body.postalCode ||
      body.plz
    );

    const radiusKm = cleanInteger(
      body.radius_km ||
      body.radiusKm ||
      body.radius
    );

    const employeesFrom = cleanInteger(
      body.employees_from ||
      body.employeesFrom ||
      body.mitarbeiter_von
    );

    const employeesTo = cleanInteger(
      body.employees_to ||
      body.employeesTo ||
      body.mitarbeiter_bis
    );

    const requestedCount = Math.min(
      Math.max(
        cleanInteger(
          body.amount_requested ||
          body.requested_count ||
          body.requestedCount ||
          body.anzahl,
          50
        ),
        1
      ),
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

    const prompt = buildResearchPrompt({
      industry,
      postalCode,
      radiusKm,
      employeesFrom,
      employeesTo,
      requestedCount,
      additionalCriteria,
      exclusionCriteria
    });

    // ---------------------------------------------------------
    // 1. Suche in Supabase protokollieren
    // ---------------------------------------------------------

    const searchInsert = await supabase
      .from("lead_searches")
      .insert({
        user_id: user.id,
        industry: industry || null,
        postal_code: postalCode || null,
        radius_km: radiusKm,
        employees_from: employeesFrom,
        employees_to: employeesTo,
        requested_count: requestedCount,
        amount_requested: requestedCount,
        additional_criteria:
          additionalCriteria || null,
        exclusion_criteria:
          exclusionCriteria || null,
        status: "running"
      });

    if (searchInsert.error) {
      throw new Error(
        `Lead-Suche konnte nicht gespeichert werden: ${searchInsert.error.message}`
      );
    }

    const search = firstRow(searchInsert.data);
    const searchId = search?.id || null;

    // ---------------------------------------------------------
    // 2. Gemini mit automatischem Fallback
    // ---------------------------------------------------------

    let geminiResult;

    try {
      geminiResult =
        await callGeminiWithFallback(prompt);
    } catch (error) {
      if (searchId) {
        try {
          await supabase
            .from("lead_searches")
            .update({
              status: "failed"
            })
            .eq("id", searchId)
            .eq("user_id", user.id);
        } catch {
          // Hauptfehler nicht überschreiben.
        }
      }

      res.status(502).json({
        error: error.message,
        attempted_models:
          error.attemptedModels || GEMINI_MODELS,
        model_errors:
          error.errors || []
      });

      return;
    }

    // ---------------------------------------------------------
    // 3. Unternehmen aus KI-Antwort extrahieren
    // ---------------------------------------------------------

    const companies = normalizeCompanies(
      geminiResult.parsed
    );

    if (!companies.length) {
      if (searchId) {
        await supabase
          .from("lead_searches")
          .update({
            status: "completed"
          })
          .eq("id", searchId)
          .eq("user_id", user.id);
      }

      res.status(200).json({
        success: true,
        model: geminiResult.model,
        attempted_models:
          geminiResult.attemptedModels,
        companies: [],
        count: 0,
        message:
          "Die Recherche wurde durchgeführt, aber es wurden keine verwertbaren Unternehmen gefunden."
      });

      return;
    }

    // ---------------------------------------------------------
    // 4. Unternehmen + Leads speichern
    // ---------------------------------------------------------

    const savedCompanies = [];
    const savedLeads = [];

    for (const company of companies) {
      try {
        const companyResult =
          await createCompany(
            user.id,
            company
          );

        const savedCompany =
          companyResult.company;

        if (!savedCompany?.id) {
          continue;
        }

        savedCompanies.push({
          ...savedCompany,
          newly_created:
            companyResult.created
        });

        const lead = await createLead(
          user.id,
          savedCompany.id,
          searchId
        );

        if (lead) {
          savedLeads.push(lead);
        }

        await createLeadSource(
          user.id,
          savedCompany.id,
          searchId,
          company
        );

      } catch (error) {
        console.error(
          `[lead-search] Fehler bei ${company.name}:`,
          error
        );
      }
    }

    // ---------------------------------------------------------
    // 5. Suche abschließen
    // ---------------------------------------------------------

    if (searchId) {
      try {
        await supabase
          .from("lead_searches")
          .update({
            status: "completed"
          })
          .eq("id", searchId)
          .eq("user_id", user.id);
      } catch (error) {
        console.error(
          "[lead-search] Status konnte nicht aktualisiert werden:",
          error
        );
      }
    }

    // ---------------------------------------------------------
    // 6. Antwort an Frontend
    // ---------------------------------------------------------

    res.status(200).json({
      success: true,

      search_id: searchId,

      model: geminiResult.model,

      attempted_models:
        geminiResult.attemptedModels,

      companies: savedCompanies,

      leads: savedLeads,

      count: savedCompanies.length,

      requested_count: requestedCount,

      message:
        `${savedCompanies.length} Unternehmen wurden recherchiert und im CRM gespeichert.`
    });

  } catch (error) {
    console.error(
      "[lead-search] Allgemeiner Fehler:",
      error
    );

    res.status(500).json({
      error:
        error?.message ||
        "Interner Serverfehler."
    });
  }
}