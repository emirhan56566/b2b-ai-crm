import { supabase } from "./supabase.js";

const MAX_RESULTS = 50;

const PROVIDERS = [
  {
    name: "groq",
    envKey: "GROQ_API_KEY",
    models: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b"
    ]
  },

  {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    models: [
      "openrouter/free"
    ]
  },

  {
    name: "huggingface",
    envKey: "HF_TOKEN",
    models: [
      "openai/gpt-oss-120b"
    ]
  },

  {
    name: "gemini",
    envKey: "GEMINI_API_KEY",
    models: []
  }
];

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

    for (const part of Object.values(value)) {
      const result = extractText(part);

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
    // Weiter versuchen.
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(
        cleaned.slice(firstBrace, lastBrace + 1)
      );
    } catch {
      // Weiter versuchen.
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
      // Weiter versuchen.
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
      company.unternehmen ||
      company.legal_name
  );

  if (!name) {
    return null;
  }

  return {
    name,

    legal_name: cleanString(
      company.legal_name ||
        company.name
    ),

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
        company.website
    )
  };
}

function normalizeCompanies(parsed) {
  let companies = [];

  if (Array.isArray(parsed)) {
    companies = parsed;
  } else if (
    parsed &&
    Array.isArray(parsed.companies)
  ) {
    companies = parsed.companies;
  } else if (
    parsed &&
    Array.isArray(parsed.leads)
  ) {
    companies = parsed.leads;
  } else if (
    parsed &&
    Array.isArray(parsed.results)
  ) {
    companies = parsed.results;
  } else if (
    parsed &&
    Array.isArray(parsed.unternehmen)
  ) {
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

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(company);
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

Recherchiere reale Unternehmen in Deutschland, die möglichst genau
zu den angegebenen B2B-Suchkriterien passen.

SUCHKRITERIEN

Branche:
${industry || "Keine spezielle Branche angegeben"}

Postleitzahl:
${postalCode || "Keine PLZ angegeben"}

Suchradius:
${radiusKm || "Kein Radius angegeben"} km

Mitarbeiter von:
${employeesFrom ?? "Keine Angabe"}

Mitarbeiter bis:
${employeesTo ?? "Keine Angabe"}

Gewünschte Anzahl:
${requestedCount}

Zusätzliche Kriterien:
${additionalCriteria || "Keine"}

Ausschlusskriterien:
${exclusionCriteria || "Keine"}

RECHERCHE-REGELN

1. Suche ausschließlich nach real existierenden Unternehmen.
2. Nutze öffentlich zugängliche Informationen.
3. Nutze die Websuche, wenn der Anbieter diese unterstützt.
4. Bevorzuge offizielle Unternehmenswebseiten.
5. Erfinde niemals Unternehmen.
6. Erfinde niemals Telefonnummern.
7. Erfinde niemals Webseiten.
8. Erfinde niemals Mitarbeiterzahlen.
9. Wenn eine Information nicht zuverlässig gefunden wird, lasse sie leer.
10. Keine Privatpersonen.
11. Keine erfundenen Ansprechpartner.
12. Keine Duplikate.
13. Beachte die Branche.
14. Beachte PLZ und Radius möglichst genau.
15. Beachte die Mitarbeitergrenze.
16. Beachte Zusatzkriterien.
17. Beachte Ausschlusskriterien.
18. Liefere maximal ${requestedCount} Unternehmen.
19. Wenn weniger passende Unternehmen gefunden werden, liefere nur tatsächlich gefundene Unternehmen.
20. Jede Firma muss nachvollziehbar recherchiert sein.

AUSGABE

Antworte ausschließlich mit gültigem JSON.

Format:

{
  "companies": [
    {
      "name": "Firmenname",
      "legal_name": "Rechtlicher Firmenname oder leer",
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

/* ---------------------------------------------------------
   OPENAI-COMPATIBLE PROVIDER
--------------------------------------------------------- */

async function callOpenAICompatible({
  provider,
  model,
  apiKey,
  prompt,
  baseUrl,
  extraHeaders = {},
  tools = undefined
}) {
  const body = {
    model,

    messages: [
      {
        role: "user",
        content: prompt
      }
    ],

    temperature: 0,

    response_format: {
      type: "json_object"
    }
  };

  if (tools) {
    body.tools = tools;
  }

  const response = await fetch(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        Authorization:
          `Bearer ${apiKey}`,

        ...extraHeaders
      },

      body: JSON.stringify(body)
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
    error.provider = provider;
    error.model = model;

    throw error;
  }

  const text =
    data?.choices?.[0]?.message?.content ||
    extractText(data);

  if (!text) {
    throw new Error(
      `${provider} ${model} hat keine Textantwort geliefert.`
    );
  }

  const parsed =
    parseJsonFromText(text);

  if (!parsed) {
    throw new Error(
      `${provider} ${model} hat kein gültiges JSON geliefert.`
    );
  }

  return {
    provider,
    model,
    parsed,
    data
  };
}

/* ---------------------------------------------------------
   GROQ
--------------------------------------------------------- */

async function callGroq(
  model,
  prompt
) {
  const apiKey =
    process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY ist nicht gesetzt."
    );
  }

  return callOpenAICompatible({
    provider: "groq",
    model,
    apiKey,
    prompt,

    baseUrl:
      "https://api.groq.com/openai/v1",

    tools:
      model === "openai/gpt-oss-120b" ||
      model === "openai/gpt-oss-20b"
        ? [
            {
              type: "browser_search"
            }
          ]
        : undefined
  });
}

/* ---------------------------------------------------------
   OPENROUTER
--------------------------------------------------------- */

async function callOpenRouter(
  model,
  prompt
) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY ist nicht gesetzt."
    );
  }

  return callOpenAICompatible({
    provider: "openrouter",
    model,
    apiKey,
    prompt,

    baseUrl:
      "https://openrouter.ai/api/v1",

    extraHeaders: {
      "HTTP-Referer":
        "https://b2b-ai-crm.vercel.app",

      "X-Title":
        "B2B AI CRM"
    }
  });
}

/* ---------------------------------------------------------
   HUGGING FACE
--------------------------------------------------------- */

async function callHuggingFace(
  model,
  prompt
) {
  const apiKey =
    process.env.HF_TOKEN;

  if (!apiKey) {
    throw new Error(
      "HF_TOKEN ist nicht gesetzt."
    );
  }

  return callOpenAICompatible({
    provider: "huggingface",
    model,
    apiKey,
    prompt,

    baseUrl:
      "https://router.huggingface.co/v1"
  });
}

/* ---------------------------------------------------------
   GEMINI
--------------------------------------------------------- */

async function callGemini(
  prompt
) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY ist nicht gesetzt."
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
        model: "gemini-3-flash-preview",

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
    error.provider = "gemini";
    error.model = "gemini-3-flash-preview";

    throw error;
  }

  const text =
    extractText(data);

  if (!text) {
    throw new Error(
      "Gemini hat keine Textantwort geliefert."
    );
  }

  const parsed =
    parseJsonFromText(text);

  if (!parsed) {
    throw new Error(
      "Gemini hat kein gültiges JSON geliefert."
    );
  }

  return {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    parsed,
    data
  };
}

/* ---------------------------------------------------------
   MULTI-PROVIDER ROUTER
--------------------------------------------------------- */

async function callAIWithFallback(
  prompt
) {
  const attempts = [];
  const errors = [];

  for (const provider of PROVIDERS) {
    const apiKey =
      process.env[provider.envKey];

    if (!apiKey) {
      continue;
    }

    for (const model of provider.models) {
      try {
        console.log(
          `[lead-search] Versuch: ${provider.name}/${model}`
        );

        let result;

        if (provider.name === "groq") {
          result =
            await callGroq(
              model,
              prompt
            );
        }

        else if (
          provider.name === "openrouter"
        ) {
          result =
            await callOpenRouter(
              model,
              prompt
            );
        }

        else if (
          provider.name === "huggingface"
        ) {
          result =
            await callHuggingFace(
              model,
              prompt
            );
        }

        else {
          result =
            await callGemini(
              prompt
            );
        }

        attempts.push({
          provider:
            result.provider,

          model:
            result.model,

          success:
            true
        });

        console.log(
          `[lead-search] Erfolgreich: ${result.provider}/${result.model}`
        );

        return {
          ...result,

          attempts,
          errors
        };

      } catch (error) {
        const entry = {
          provider:
            provider.name,

          model:
            model ||
            "default",

          status:
            error?.status ||
            null,

          message:
            error?.message ||
            "Unbekannter Fehler"
        };

        attempts.push({
          ...entry,
          success: false
        });

        errors.push(entry);

        console.error(
          "[lead-search] Provider fehlgeschlagen:",
          entry
        );
      }
    }
  }

  throw Object.assign(
    new Error(
      "Alle konfigurierten KI-Anbieter sind fehlgeschlagen."
    ),
    {
      attempts,
      errors
    }
  );
}

/* ---------------------------------------------------------
   AUTH
--------------------------------------------------------- */

async function getAuthenticatedUser(req) {
  const token =
    getBearerToken(req);

  if (!token) {
    return null;
  }

  try {
    const response =
      await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/user`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${token}`,

            apikey:
              process.env.SUPABASE_ANON_KEY
          }
        }
      );

    if (!response.ok) {
      return null;
    }

    const user =
      await response.json();

    return user?.id
      ? user
      : null;

  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   COMPANY
--------------------------------------------------------- */

async function findExistingCompany(
  userId,
  company
) {
  if (!userId || !company?.name) {
    return null;
  }

  try {
    if (company.website) {
      const result =
        await supabase
          .from("companies")
          .select("*")
          .eq("user_id", userId)
          .eq("website", company.website)
          .limit(1);

      const existing =
        firstRow(result.data);

      if (existing) {
        return existing;
      }
    }

    const result =
      await supabase
        .from("companies")
        .select("*")
        .eq("user_id", userId)
        .eq("name", company.name)
        .limit(1);

    return firstRow(result.data);

  } catch (error) {
    console.error(
      "[lead-search] Duplikatprüfung:",
      error
    );

    return null;
  }
}

async function createCompany(
  userId,
  company
) {
  const existing =
    await findExistingCompany(
      userId,
      company
    );

  if (existing) {
    return {
      company: existing,
      created: false
    };
  }

  const result =
    await supabase
      .from("companies")
      .insert({
        user_id:
          userId,

        name:
          company.name,

        legal_name:
          company.legal_name ||
          company.name ||
          null,

        phone:
          company.phone ||
          null,

        website:
          company.website ||
          null,

        street:
          company.street ||
          null,

        postal_code:
          company.postal_code ||
          null,

        city:
          company.city ||
          null,

        country:
          company.country ||
          "Deutschland",

        industry:
          company.industry ||
          null,

        employees:
          company.employees ||
          null,

        description:
          company.description ||
          null
      });

  if (result.error) {
    throw new Error(
      `Unternehmen konnte nicht gespeichert werden: ${result.error.message}`
    );
  }

  return {
    company:
      firstRow(result.data),

    created:
      true
  };
}

/* ---------------------------------------------------------
   LEAD
--------------------------------------------------------- */

async function createLead(
  userId,
  companyId,
  searchId
) {
  if (!companyId) {
    return null;
  }

  try {
    const existingResult =
      await supabase
        .from("leads")
        .select("*")
        .eq("user_id", userId)
        .eq("company_id", companyId)
        .limit(1);

    const existing =
      firstRow(
        existingResult.data
      );

    if (existing) {
      return existing;
    }

    const result =
      await supabase
        .from("leads")
        .insert({
          user_id:
            userId,

          company_id:
            companyId,

          status:
            "new",

          source:
            "ai_lead_search",

          lead_search_id:
            searchId ||
            null
        });

    if (result.error) {
      throw new Error(
        `Lead konnte nicht gespeichert werden: ${result.error.message}`
      );
    }

    return firstRow(result.data);

  } catch (error) {
    console.error(
      "[lead-search] Lead:",
      error
    );

    return null;
  }
}

/* ---------------------------------------------------------
   SOURCE
--------------------------------------------------------- */

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
        user_id:
          userId,

        company_id:
          companyId,

        lead_search_id:
          searchId ||
          null,

        source_type:
          "ai_search",

        source_url:
          company.source_url ||
          company.website ||
          null
      });

  } catch (error) {
    console.error(
      "[lead-search] lead_sources:",
      error
    );
  }
}

/* ---------------------------------------------------------
   HAUPT-API
--------------------------------------------------------- */

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    res.status(405).json({
      error:
        "Method not allowed"
    });

    return;
  }

  let searchId = null;

  try {
    const user =
      await getAuthenticatedUser(req);

    if (!user?.id) {
      res.status(401).json({
        error:
          "Nicht authentifiziert."
      });

      return;
    }

    const body =
      req.body || {};

    const industry =
      cleanString(
        body.industry ||
        body.branche
      );

    const postalCode =
      cleanString(
        body.postal_code ||
        body.postalCode ||
        body.plz
      );

    const radiusKm =
      cleanInteger(
        body.radius_km ||
        body.radiusKm ||
        body.radius
      );

    const employeesFrom =
      cleanInteger(
        body.employees_from ||
        body.employeesFrom ||
        body.mitarbeiter_von
      );

    const employeesTo =
      cleanInteger(
        body.employees_to ||
        body.employeesTo ||
        body.mitarbeiter_bis
      );

    const requestedCount =
      Math.min(
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

    const additionalCriteria =
      cleanString(
        body.additional_criteria ||
        body.additionalCriteria ||
        body.zusatzkriterien
      );

    const exclusionCriteria =
      cleanString(
        body.exclusion_criteria ||
        body.exclusionCriteria ||
        body.ausschlusskriterien
      );

    const prompt =
      buildResearchPrompt({
        industry,
        postalCode,
        radiusKm,
        employeesFrom,
        employeesTo,
        requestedCount,
        additionalCriteria,
        exclusionCriteria
      });

    const searchInsert =
      await supabase
        .from("lead_searches")
        .insert({
          user_id:
            user.id,

          industry:
            industry ||
            null,

          postal_code:
            postalCode ||
            null,

          radius_km:
            radiusKm,

          employees_from:
            employeesFrom,

          employees_to:
            employeesTo,

          requested_count:
            requestedCount,

          amount_requested:
            requestedCount,

          additional_criteria:
            additionalCriteria ||
            null,

          exclusion_criteria:
            exclusionCriteria ||
            null,

          status:
            "running"
        });

    if (searchInsert.error) {
      throw new Error(
        `Lead-Suche konnte nicht gespeichert werden: ${searchInsert.error.message}`
      );
    }

    const search =
      firstRow(
        searchInsert.data
      );

    searchId =
      search?.id ||
      null;

    /* -----------------------------------------------------
       KI ROUTER
    ----------------------------------------------------- */

    let aiResult;

    try {
      aiResult =
        await callAIWithFallback(
          prompt
        );

    } catch (error) {
      console.error(
        "[lead-search] Alle KI-Anbieter fehlgeschlagen",
        error
      );

      if (searchId) {
        await supabase
          .from("lead_searches")
          .update({
            status:
              "failed"
          })
          .eq(
            "id",
            searchId
          )
          .eq(
            "user_id",
            user.id
          );
      }

      res.status(502).json({
        error:
          error.message,

        attempts:
          error.attempts ||
          [],

        provider_errors:
          error.errors ||
          []
      });

      return;
    }

    const companies =
      normalizeCompanies(
        aiResult.parsed
      );

    if (!companies.length) {
      await supabase
        .from("lead_searches")
        .update({
          status:
            "completed"
        })
        .eq(
          "id",
          searchId
        )
        .eq(
          "user_id",
          user.id
        );

      res.status(200).json({
        success:
          true,

        search_id:
          searchId,

        provider:
          aiResult.provider,

        model:
          aiResult.model,

        companies:
          [],

        leads:
          [],

        count:
          0,

        message:
          "Die Recherche wurde durchgeführt, aber es wurden keine verwertbaren Unternehmen gefunden."
      });

      return;
    }

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

        const lead =
          await createLead(
            user.id,
            savedCompany.id,
            searchId
          );

        if (lead) {
          savedLeads.push(
            lead
          );
        }

        await createLeadSource(
          user.id,
          savedCompany.id,
          searchId,
          company
        );

      } catch (error) {
        console.error(
          `[lead-search] Unternehmen "${company.name}":`,
          error
        );
      }
    }

    await supabase
      .from("lead_searches")
      .update({
        status:
          "completed"
      })
      .eq(
        "id",
        searchId
      )
      .eq(
        "user_id",
        user.id
      );

    res.status(200).json({
      success:
        true,

      search_id:
        searchId,

      provider:
        aiResult.provider,

      model:
        aiResult.model,

      companies:
        savedCompanies,

      leads:
        savedLeads,

      count:
        savedCompanies.length,

      requested_count:
        requestedCount,

      attempts:
        aiResult.attempts,

      message:
        `${savedCompanies.length} Unternehmen wurden recherchiert und im CRM gespeichert.`
    });

  } catch (error) {
    console.error(
      "[lead-search] Allgemeiner Fehler:",
      error
    );

    if (searchId) {
      try {
        await supabase
          .from("lead_searches")
          .update({
            status:
              "failed"
          })
          .eq(
            "id",
            searchId
          );
      } catch {
        // Hauptfehler behalten.
      }
    }

    res.status(500).json({
      error:
        error?.message ||
        "Interner Serverfehler."
    });
  }
}