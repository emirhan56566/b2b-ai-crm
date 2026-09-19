// api/lead-search.js
// Ablauf:
// 1. Benutzer authentifizieren
// 2. Tavily durchsucht das Web
// 3. Groq analysiert die gefundenen Webseiten
// 4. Unternehmen werden dedupliziert
// 5. Unternehmen + Leads werden in Supabase gespeichert

const GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b"
];

const TAVILY_URL = "https://api.tavily.com/search";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const MAX_TAVILY_RESULTS_PER_QUERY = 8;
const SEARCH_QUERY_COUNT = 3;

// ---------------------------------------------------------
// Allgemeine Hilfsfunktionen
// ---------------------------------------------------------

function json(res, status, data) {
  res.status(status).json(data);
}

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

function normalizeEmployees(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  const text = String(value).trim();

  // Beispiele:
  // "25"
  // "25 Mitarbeiter"
  // "25-50"
  // "ca. 40"
  const match = text.match(/\d[\d.,]*/);

  if (!match) {
    return null;
  }

  const normalized = match[0]
    .replace(/\./g, "")
    .replace(",", ".");

  const number = Number(normalized);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(number);
}

function normalizeUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    return parsed.href;
  } catch {
    return String(url).trim();
  }
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------
// Timeout-fähiger Fetch
// ---------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Zeitüberschreitung bei ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------
// Supabase
// ---------------------------------------------------------

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL fehlt in Vercel.");
  }

  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt in Vercel.");
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    serviceRoleKey
  };
}

async function supabaseRequest(path, options = {}, timeoutMs = 15000) {
  const {
    supabaseUrl,
    serviceRoleKey
  } = getSupabaseConfig();

  const response = await fetchWithTimeout(
    `${supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        ...options.headers
      }
    },
    timeoutMs
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const errorMessage =
      typeof data === "object" && data?.message
        ? data.message
        : typeof data === "object" && data?.hint
          ? data.hint
          : text || `Supabase HTTP ${response.status}`;

    throw new Error(
      `Supabase HTTP ${response.status}: ${errorMessage}`
    );
  }

  return data;
}

// ---------------------------------------------------------
// Authentifizierung
// ---------------------------------------------------------

async function getAuthenticatedUser(req) {
  const authorization =
    req.headers.authorization ||
    req.headers.Authorization;

  if (!authorization) {
    throw new Error("Nicht authentifiziert.");
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new Error("Ungültiger Authorization-Header.");
  }

  const accessToken = match[1];

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL fehlt.");
  }

  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY fehlt.");
  }

  const response = await fetchWithTimeout(
    `${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    },
    10000
  );

  if (!response.ok) {
    throw new Error(
      `Supabase Auth HTTP ${response.status}`
    );
  }

  const user = await response.json();

  if (!user?.id) {
    throw new Error("Supabase konnte den Benutzer nicht ermitteln.");
  }

  return user;
}

// ---------------------------------------------------------
// Tavily Websuche
// ---------------------------------------------------------

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY fehlt in den Vercel Environment Variables."
    );
  }

  const response = await fetchWithTimeout(
    TAVILY_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        topic: "general",
        max_results: MAX_TAVILY_RESULTS_PER_QUERY,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    },
    20000
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.detail ||
      data?.message ||
      text ||
      `Tavily HTTP ${response.status}`;

    throw new Error(
      `Tavily HTTP ${response.status}: ${message}`
    );
  }

  return Array.isArray(data?.results)
    ? data.results
    : [];
}

// ---------------------------------------------------------
// Suchbegriffe erzeugen
// ---------------------------------------------------------

function buildSearchQueries(criteria) {
  const industry =
    cleanString(criteria.industry) ||
    "B2B Unternehmen";

  const postalCode =
    cleanString(criteria.postal_code);

  const radius =
    cleanString(criteria.radius_km);

  const employeesFrom =
    cleanString(criteria.employees_from);

  const employeesTo =
    cleanString(criteria.employees_to);

  const additionalCriteria =
    cleanString(criteria.additional_criteria);

  const exclusionCriteria =
    cleanString(criteria.exclusion_criteria);

  const locationPart = postalCode
    ? `in der Nähe von ${postalCode}${radius ? ` innerhalb von ${radius} km` : ""}`
    : "in Deutschland";

  const employeePart =
    employeesFrom || employeesTo
      ? `Unternehmen mit ungefähr ${employeesFrom || "1"} bis ${employeesTo || "unbegrenzt"} Mitarbeitern`
      : "";

  const queries = [
    `${industry} ${locationPart} ${employeePart} ${additionalCriteria}`,

    `${industry} Deutschland ${postalCode || ""} Firmen Unternehmen ${additionalCriteria}`,

    `${industry} ${locationPart} ${employeePart} Kontakt Telefon Adresse Website`
  ];

  // Ausschlusskriterien in Suchanfrage einbauen
  return queries.map(query => {
    let result = query;

    if (exclusionCriteria) {
      result += ` Ausschließen: ${exclusionCriteria}`;
    }

    return result
      .replace(/\s+/g, " ")
      .trim();
  });
}

// ---------------------------------------------------------
// Suchergebnisse normalisieren
// ---------------------------------------------------------

function normalizeSearchResults(results) {
  const seen = new Set();
  const normalized = [];

  for (const result of results) {
    const url = normalizeUrl(
      result?.url ||
      result?.link
    );

    const title = cleanString(
      result?.title
    );

    const content = cleanString(
      result?.content ||
      result?.snippet ||
      result?.description
    );

    const domain = domainFromUrl(url);

    if (!url || !domain) {
      continue;
    }

    const key = `${domain}|${title}`.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    normalized.push({
      title,
      url,
      domain,
      content
    });
  }

  return normalized;
}

// ---------------------------------------------------------
// Groq
// ---------------------------------------------------------

function buildGroqSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: {
              type: "string"
            },
            legal_name: {
              type: ["string", "null"]
            },
            website: {
              type: ["string", "null"]
            },
            phone: {
              type: ["string", "null"]
            },
            address: {
              type: ["string", "null"]
            },
            city: {
              type: ["string", "null"]
            },
            postal_code: {
              type: ["string", "null"]
            },
            country: {
              type: ["string", "null"]
            },
            industry: {
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
            source_title: {
              type: ["string", "null"]
            }
          },
          required: [
            "name",
            "legal_name",
            "website",
            "phone",
            "address",
            "city",
            "postal_code",
            "country",
            "industry",
            "employees",
            "description",
            "source_url",
            "source_title"
          ]
        }
      }
    },
    required: ["companies"]
  };
}

function buildGroqPrompt(criteria, searchResults) {
  return `
Du bist ein B2B-Lead-Recherche-System für einen deutschen CRM.

Aufgabe:
Analysiere ausschließlich die unten gelieferten Websuchergebnisse.

Finde reale Unternehmen in Deutschland, die möglichst gut zu den Suchkriterien passen.

WICHTIGE REGELN:

1. Erfinde niemals Unternehmen.
2. Erfinde niemals Telefonnummern.
3. Erfinde niemals Adressen.
4. Erfinde niemals Mitarbeiterzahlen.
5. Verwende nur Informationen, die aus den gelieferten Quellen nachvollziehbar sind.
6. Bevorzuge offizielle Unternehmenswebseiten.
7. Bevorzuge echte Unternehmen gegenüber Verzeichnissen.
8. Keine Privatpersonen.
9. Keine Fake-Unternehmen.
10. Keine offensichtlich irrelevanten Unternehmen.
11. Wenn eine Information nicht sicher aus den Quellen hervorgeht, setze sie auf null.
12. source_url muss eine tatsächlich gelieferte URL sein.
13. Telefonnummer nur übernehmen, wenn sie in den Quellen erkennbar ist.
14. Mitarbeiterzahl nur übernehmen, wenn sie in den Quellen erkennbar ist.
15. Gib jedes Unternehmen höchstens einmal zurück.
16. Berücksichtige die Ausschlusskriterien.
17. Deutschland ist das Zielland.
18. Die Ausgabe muss exakt dem vorgegebenen JSON-Schema entsprechen.

SUCHKRITERIEN:

Branche:
${cleanString(criteria.industry) || "nicht angegeben"}

PLZ:
${cleanString(criteria.postal_code) || "nicht angegeben"}

Radius:
${cleanString(criteria.radius_km) || "nicht angegeben"} km

Mitarbeiter von:
${cleanString(criteria.employees_from) || "nicht angegeben"}

Mitarbeiter bis:
${cleanString(criteria.employees_to) || "nicht angegeben"}

Zusatzkriterien:
${cleanString(criteria.additional_criteria) || "keine"}

Ausschlusskriterien:
${cleanString(criteria.exclusion_criteria) || "keine"}

Anzahl gewünschter Leads:
${cleanString(criteria.amount_requested || criteria.requested_count) || "50"}

WEB-SUCHERGEBNISSE:

${JSON.stringify(searchResults, null, 2)}
`;
}

async function callGroq(model, prompt) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY fehlt in den Vercel Environment Variables."
    );
  }

  const response = await fetchWithTimeout(
    GROQ_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "Du bist ein präzises B2B-Recherche-System. Antworte ausschließlich gemäß dem vorgegebenen JSON-Schema."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "b2b_companies",
            strict: true,
            schema: buildGroqSchema()
          }
        }
      })
    },
    30000
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      text ||
      `Groq HTTP ${response.status}`;

    throw new Error(
      `${model}: Groq HTTP ${response.status}: ${message}`
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      `${model}: Groq hat keine Antwort geliefert.`
    );
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error(
      `${model}: Groq hat kein gültiges JSON geliefert.`
    );
  }
}

async function callGroqWithFallback(prompt) {
  const errors = [];

  for (const model of GROQ_MODELS) {
    try {
      return await callGroq(model, prompt);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(
    `Alle Groq-Modelle sind fehlgeschlagen:\n${errors.join("\n")}`
  );
}

// ---------------------------------------------------------
// Unternehmen deduplizieren
// ---------------------------------------------------------

function deduplicateCompanies(companies) {
  const map = new Map();

  for (const company of companies) {
    const name = cleanString(company?.name);
    const website = cleanString(company?.website);

    if (!name) {
      continue;
    }

    const domain = domainFromUrl(website);

    const key = (
      domain ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9äöüß]/gi, "")
    );

    if (!key) {
      continue;
    }

    if (!map.has(key)) {
      map.set(key, company);
    }
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------
// Bestehendes Unternehmen suchen
// ---------------------------------------------------------

async function findExistingCompany(userId, company) {
  const name = cleanString(company.name);
  const website = cleanString(company.website);

  if (website) {
    const domain = domainFromUrl(website);

    if (domain) {
      const rows = await supabaseRequest(
        `companies?user_id=eq.${encodeURIComponent(userId)}&website=ilike.*${encodeURIComponent(domain)}*&select=*`,
        {
          method: "GET"
        }
      );

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
    }
  }

  if (name) {
    const rows = await supabaseRequest(
      `companies?user_id=eq.${encodeURIComponent(userId)}&name=ilike.${encodeURIComponent(name)}&select=*`,
      {
        method: "GET"
      }
    );

    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }
  }

  return null;
}

// ---------------------------------------------------------
// Unternehmen speichern
// ---------------------------------------------------------

async function saveCompany(userId, company) {
  const existing = await findExistingCompany(
    userId,
    company
  );

  if (existing) {
    return existing;
  }

  const payload = {
    user_id: userId,
    name: cleanString(company.name),
    legal_name: company.legal_name
      ? cleanString(company.legal_name)
      : null,
    website: company.website
      ? normalizeUrl(company.website)
      : null,
    phone: company.phone
      ? cleanString(company.phone)
      : null,
    address: company.address
      ? cleanString(company.address)
      : null,
    city: company.city
      ? cleanString(company.city)
      : null,
    postal_code: company.postal_code
      ? cleanString(company.postal_code)
      : null,
    country: company.country
      ? cleanString(company.country)
      : "Deutschland",
    industry: company.industry
      ? cleanString(company.industry)
      : null,
    employees: normalizeEmployees(company.employees),
    description: company.description
      ? cleanString(company.description)
      : null
  };

  const rows = await supabaseRequest(
    "companies",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  if (!Array.isArray(rows) || !rows[0]) {
    throw new Error(
      "Unternehmen konnte nicht in Supabase gespeichert werden."
    );
  }

  return rows[0];
}

// ---------------------------------------------------------
// Lead speichern
// ---------------------------------------------------------

async function saveLead(
  userId,
  companyId,
  leadSearchId
) {
  const existing = await supabaseRequest(
    `leads?user_id=eq.${encodeURIComponent(userId)}&company_id=eq.${encodeURIComponent(companyId)}&select=*`,
    {
      method: "GET"
    }
  );

  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0];
  }

  const payload = {
    user_id: userId,
    company_id: companyId,
    status: "new",
    source: "ai_search",
    lead_search_id: leadSearchId
  };

  const rows = await supabaseRequest(
    "leads",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  return Array.isArray(rows)
    ? rows[0]
    : null;
}

// ---------------------------------------------------------
// Quelle speichern
// ---------------------------------------------------------

async function saveLeadSource(
  userId,
  leadSearchId,
  companyId,
  sourceUrl,
  sourceTitle
) {
  if (!sourceUrl) {
    return;
  }

  const payload = {
    user_id: userId,
    lead_search_id: leadSearchId,
    company_id: companyId,
    source_type: "tavily",
    source_url: sourceUrl,
    source_title: sourceTitle || null
  };

  try {
    await supabaseRequest(
      "lead_sources",
      {
        method: "POST",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify(payload)
      }
    );
  } catch (error) {
    // Quellen dürfen die eigentliche Lead-Speicherung
    // nicht zerstören.
    console.error(
      "Lead-Quelle konnte nicht gespeichert werden:",
      error?.message || error
    );
  }
}

// ---------------------------------------------------------
// Lead Search anlegen
// ---------------------------------------------------------

async function createLeadSearch(userId, criteria) {
  const requestedCount =
    toNumberOrNull(
      criteria.amount_requested ??
      criteria.requested_count
    ) || 50;

  const payload = {
    user_id: userId,
    status: "running",
    industry:
      cleanString(criteria.industry) || null,
    postal_code:
      cleanString(criteria.postal_code) || null,
    radius_km:
      toNumberOrNull(criteria.radius_km),
    employees_from:
      toNumberOrNull(criteria.employees_from),
    employees_to:
      toNumberOrNull(criteria.employees_to),
    additional_criteria:
      cleanString(criteria.additional_criteria) || null,
    exclusion_criteria:
      cleanString(criteria.exclusion_criteria) || null,
    requested_count: requestedCount,
    amount_requested: requestedCount
  };

  const rows = await supabaseRequest(
    "lead_searches",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  if (!Array.isArray(rows) || !rows[0]) {
    throw new Error(
      "Lead-Suche konnte nicht gespeichert werden."
    );
  }

  return rows[0];
}

// ---------------------------------------------------------
// Lead Search aktualisieren
// ---------------------------------------------------------

async function updateLeadSearch(
  leadSearchId,
  values
) {
  await supabaseRequest(
    `lead_searches?id=eq.${encodeURIComponent(leadSearchId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify(values)
    }
  );
}

// ---------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error: "Method Not Allowed"
    });
  }

  let leadSearch = null;

  try {
    const user = await getAuthenticatedUser(req);

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const criteria = {
      industry:
        body.industry ||
        body.branches ||
        body.branch ||
        "",

      postal_code:
        body.postal_code ||
        body.postalCode ||
        "",

      radius_km:
        body.radius_km ??
        body.radius ??
        "",

      employees_from:
        body.employees_from ??
        body.employeesFrom ??
        "",

      employees_to:
        body.employees_to ??
        body.employeesTo ??
        "",

      additional_criteria:
        body.additional_criteria ||
        body.additionalCriteria ||
        "",

      exclusion_criteria:
        body.exclusion_criteria ||
        body.exclusionCriteria ||
        "",

      amount_requested:
        body.amount_requested ??
        body.requested_count ??
        body.amount ??
        body.count ??
        50
    };

    // -----------------------------------------------------
    // Lead Search speichern
    // -----------------------------------------------------

    leadSearch = await createLeadSearch(
      user.id,
      criteria
    );

    // -----------------------------------------------------
    // Tavily Suche
    // -----------------------------------------------------

    const queries =
      buildSearchQueries(criteria);

    let tavilyResults = [];

    const searchResponses =
      await Promise.all(
        queries
          .slice(0, SEARCH_QUERY_COUNT)
          .map(query => tavilySearch(query))
      );

    for (const results of searchResponses) {
      tavilyResults.push(...results);
    }

    tavilyResults =
      normalizeSearchResults(tavilyResults);

    if (tavilyResults.length === 0) {
      await updateLeadSearch(
        leadSearch.id,
        {
          status: "completed",
          results_count: 0
        }
      );

      return json(res, 200, {
        success: true,
        lead_search_id: leadSearch.id,
        results_count: 0,
        companies: [],
        message:
          "Es wurden keine verwertbaren Web-Ergebnisse gefunden."
      });
    }

    // -----------------------------------------------------
    // Groq Analyse
    // -----------------------------------------------------

    const groqPrompt =
      buildGroqPrompt(
        criteria,
        tavilyResults
      );

    const aiResult =
      await callGroqWithFallback(
        groqPrompt
      );

    let companies =
      Array.isArray(aiResult?.companies)
        ? aiResult.companies
        : [];

    companies =
      deduplicateCompanies(companies);

    // Gewünschte Anzahl begrenzen
    const requestedCount =
      Number(criteria.amount_requested) || 50;

    companies =
      companies.slice(
        0,
        Math.max(1, requestedCount)
      );

    // -----------------------------------------------------
    // In Supabase speichern
    // -----------------------------------------------------

    const savedCompanies = [];
    const errors = [];

    for (const company of companies) {
      try {
        const savedCompany =
          await saveCompany(
            user.id,
            company
          );

        const lead =
          await saveLead(
            user.id,
            savedCompany.id,
            leadSearch.id
          );

        await saveLeadSource(
          user.id,
          leadSearch.id,
          savedCompany.id,
          company.source_url,
          company.source_title
        );

        savedCompanies.push({
          company: savedCompany,
          lead
        });
      } catch (error) {
        console.error(
          "Unternehmen konnte nicht gespeichert werden:",
          error?.message || error
        );

        errors.push({
          company:
            company?.name || "Unbekannt",
          error:
            error?.message ||
            String(error)
        });
      }
    }

    // -----------------------------------------------------
    // Suche abschließen
    // -----------------------------------------------------

    await updateLeadSearch(
      leadSearch.id,
      {
        status: "completed",
        results_count:
          savedCompanies.length
      }
    );

    return json(res, 200, {
      success: true,
      lead_search_id: leadSearch.id,
      results_count:
        savedCompanies.length,
      companies:
        savedCompanies.map(item => ({
          ...item.company,
          lead: item.lead
        })),
      save_errors: errors
    });

  } catch (error) {
    console.error(
      "Lead Search Fehler:",
      error?.message || error
    );

    if (leadSearch?.id) {
      try {
        await updateLeadSearch(
          leadSearch.id,
          {
            status: "failed",
            results_count: 0
          }
        );
      } catch {
        // Originalfehler behalten
      }
    }

    return json(res, 500, {
      success: false,
      error:
        error?.message ||
        "Unbekannter Fehler bei der KI-Lead-Suche."
    });
  }
}