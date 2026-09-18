import { supabase } from "./supabase.js";

const GEMINI_MODEL = "gemini-3.6-flash";
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
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY fehlt.");
    }

    if (!process.env.SUPABASE_URL) {
      throw new Error("SUPABASE_URL fehlt.");
    }

    if (!process.env.SUPABASE_ANON_KEY) {
      throw new Error("SUPABASE_ANON_KEY fehlt.");
    }

    const auth = await authenticate(req);

    if (!auth.user) {
      return res.status(401).json({
        success: false,
        error: auth.error,
      });
    }

    const userId = auth.user.id;
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
        error:
          "Bitte mindestens Branche, PLZ oder zusätzliche Kriterien angeben.",
      });
    }

    const query = [
      industry && `Branche: ${industry}`,
      postalCode && `PLZ: ${postalCode}`,
      radiusKm && `Radius: ${radiusKm} km`,
      employeesFrom !== null &&
        `Mitarbeiter ab: ${employeesFrom}`,
      employeesTo !== null &&
        `Mitarbeiter bis: ${employeesTo}`,
      `Anzahl: ${requestedCount}`,
      additionalCriteria &&
        `Zusatzkriterien: ${additionalCriteria}`,
      exclusionCriteria &&
        `Ausschlusskriterien: ${exclusionCriteria}`,
    ]
      .filter(Boolean)
      .join(" | ");

    // Suchlauf speichern
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

    // Bestehende Unternehmen laden
    const existingResult = await supabase
      .from("companies")
      .select(
        "id,name,phone,email,website,address,postal_code,city,country,industry,employees"
      )
      .eq("user_id", userId)
      .limit(5000);

    if (existingResult.error) {
      throw new Error(
        `Bestehende Unternehmen konnten nicht geladen werden: ${existingResult.error.message}`
      );
    }

    const existingCompanies = existingResult.data || [];

    // KI-Recherche
    const prompt = buildPrompt({
      industry,
      postalCode,
      radiusKm,
      employeesFrom,
      employeesTo,
      requestedCount,
      additionalCriteria,
      exclusionCriteria,
    });

    const aiData = await callGemini(prompt);

    const companies = normalizeCompanies(
      extractCompanies(aiData)
    );

    if (!companies.length) {
      await updateSearch(searchId, {
        status: "completed",
        results_count: 0,
        completed_at: new Date().toISOString(),
      });

      return res.status(200).json({
        success: true,
        search_id: searchId,
        model: GEMINI_MODEL,
        companies: [],
        results_count: 0,
      });
    }

    // Duplikate entfernen
    const uniqueCompanies = removeDuplicates(
      companies,
      existingCompanies
    );

    const savedCompanies = [];
    const skipped = [];

    // Unternehmen speichern
    for (const company of uniqueCompanies) {
      try {
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
          skipped.push({
            name: company.name,
            reason: companyInsert.error.message,
          });
          continue;
        }

        const companyId = companyInsert.data?.id;

        if (!companyId) {
          skipped.push({
            name: company.name,
            reason: "Unternehmen-ID fehlt.",
          });
          continue;
        }

        // Kontakt speichern
        let contactId = null;

        if (company.contact) {
          const hasContactData =
            company.contact.first_name ||
            company.contact.last_name ||
            company.contact.email ||
            company.contact.phone;

          if (hasContactData) {
            const contactInsert = await supabase
              .from("contacts")
              .insert({
                user_id: userId,
                company_id: companyId,
                first_name:
                  company.contact.first_name || null,
                last_name:
                  company.contact.last_name || null,
                job_title:
                  company.contact.job_title || null,
                email:
                  company.contact.email || null,
                phone:
                  company.contact.phone || null,
                mobile:
                  company.contact.mobile || null,
              });

            if (!contactInsert.error) {
              contactId = contactInsert.data?.id || null;
            }
          }
        }

        // Lead speichern
        const leadInsert = await supabase
          .from("leads")
          .insert({
            user_id: userId,
            company_id: companyId,
            contact_id: contactId,
            status: "new",
            priority: calculatePriority(company),
            source: "ai_lead_search",
            notes: company.reason
              ? `KI-Recherche: ${company.reason}`
              : `Gefunden durch KI-Lead-Suche mit ${GEMINI_MODEL}.`,
          });

        if (leadInsert.error) {
          skipped.push({
            name: company.name,
            reason: leadInsert.error.message,
          });
          continue;
        }

        const leadId = leadInsert.data?.id || null;

        // Quellen speichern
        if (leadId && Array.isArray(company.sources)) {
          for (const source of company.sources.slice(0, 10)) {
            if (!source.url) continue;

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

        // Aktivität speichern
        await supabase
          .from("activities")
          .insert({
            user_id: userId,
            company_id: companyId,
            contact_id: contactId,
            lead_id: leadId,
            type: "ai_lead_search",
            title: "Unternehmen durch KI gefunden",
            description:
              `Recherche mit ${GEMINI_MODEL}.`,
          });

        savedCompanies.push({
          id: companyId,
          lead_id: leadId,
          name: company.name,
          phone: company.phone || null,
          email: company.email || null,
          website: company.website || null,
          address: company.address || null,
          postal_code: company.postal_code || null,
          city: company.city || null,
          industry: company.industry || null,
          employees: company.employees || null,
          contact: company.contact || null,
          sources: company.sources || [],
        });
      } catch (error) {
        skipped.push({
          name: company.name,
          reason: error.message,
        });
      }
    }

    await updateSearch(searchId, {
      status: "completed",
      results_count: savedCompanies.length,
      completed_at: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      search_id: searchId,
      model: GEMINI_MODEL,
      companies: savedCompanies,
      results_count: savedCompanies.length,
      skipped_count: skipped.length,
      skipped,
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
      error:
        error?.message ||
        "Unbekannter Fehler bei der Lead-Suche.",
    });
  }
}


/* ============================================================
   AUTH
   ============================================================ */

async function authenticate(req) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return {
      user: null,
      error: "Nicht authentifiziert.",
    };
  }

  const token =
    authorization.substring(7).trim();

  if (!token) {
    return {
      user: null,
      error: "Kein Access Token vorhanden.",
    };
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    return {
      user: null,
      error:
        "Ungültige oder abgelaufene Sitzung.",
    };
  }

  const user = await response.json();

  if (!user?.id) {
    return {
      user: null,
      error:
        "Benutzer konnte nicht ermittelt werden.",
    };
  }

  return {
    user,
    error: null,
  };
}


/* ============================================================
   GEMINI INTERACTIONS API
   ============================================================ */

async function callGemini(prompt) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key":
          process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt,

        tools: [
          {
            type: "google_search",
          },
        ],

        store: false,
      }),
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
    throw new Error(
      data?.error?.message ||
      data?.message ||
      raw ||
      `Gemini API Fehler ${response.status}`
    );
  }

  if (data?.status === "failed") {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      "Gemini-Recherche fehlgeschlagen."
    );
  }

  return data;
}


/* ============================================================
   GEMINI ANTWORT AUSLESEN
   ============================================================ */

function extractCompanies(data) {
  let text = "";

  if (typeof data?.output_text === "string") {
    text = data.output_text;
  }

  if (!text && typeof data?.output?.text === "string") {
    text = data.output.text;
  }

  if (!text && Array.isArray(data?.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === "string") {
        text += output.text;
      }

      if (Array.isArray(output?.content)) {
        for (const content of output.content) {
          if (typeof content?.text === "string") {
            text += content.text;
          }
        }
      }
    }
  }

  if (!text && Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (typeof item?.text === "string") {
        text += item.text;
      }

      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (typeof content?.text === "string") {
            text += content.text;
          }
        }
      }
    }
  }

  if (!text) {
    return [];
  }

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end === -1) {
      return [];
    }

    try {
      parsed = JSON.parse(
        cleaned.slice(start, end + 1)
      );
    } catch {
      return [];
    }
  }

  return Array.isArray(parsed?.companies)
    ? parsed.companies
    : [];
}


/* ============================================================
   PROMPT
   ============================================================ */

function buildPrompt({
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
Du bist ein professioneller B2B-Unternehmens-Recherche-Agent.

Finde bis zu ${requestedCount} reale Unternehmen
für eine B2B-Vertriebsdatenbank.

SUCHKRITERIEN

Branche:
${industry || "Keine Angabe"}

PLZ:
${postalCode || "Keine Angabe"}

Radius:
${radiusKm ? `${radiusKm} km` : "Keine Angabe"}

Mitarbeiter:
${employeesFrom ?? "Keine Untergrenze"}
bis
${employeesTo ?? "Keine Obergrenze"}

Zusätzliche Kriterien:
${additionalCriteria || "Keine"}

Ausschlusskriterien:
${exclusionCriteria || "Keine"}

RECHERCHE

Nutze Google Search.

Suche ausschließlich nach real existierenden Unternehmen.

Nutze bevorzugt:
- offizielle Unternehmenswebsites
- Impressum
- Handelsregister-nahe öffentliche Informationen
- seriöse Unternehmensverzeichnisse
- öffentliche Unternehmensprofile

ERFINDUNGSVERBOT

Erfinde niemals:
- Unternehmen
- Telefonnummern
- E-Mail-Adressen
- Websites
- Adressen
- Mitarbeiterzahlen
- Ansprechpartner
- Quellen

Wenn eine Information nicht zuverlässig gefunden wird,
lasse sie leer.

Achte darauf, dass jedes Unternehmen die Suchkriterien
möglichst tatsächlich erfüllt.

Keine Duplikate.

Keine privaten Kontaktdaten.

AUSGABE

Antworte ausschließlich mit gültigem JSON.

Format:

{
  "companies": [
    {
      "name": "",
      "phone": "",
      "email": "",
      "website": "",
      "address": "",
      "postal_code": "",
      "city": "",
      "country": "Deutschland",
      "industry": "",
      "employees": null,
      "description": "",
      "reason": "",
      "contact": {
        "first_name": "",
        "last_name": "",
        "job_title": "",
        "email": "",
        "phone": "",
        "mobile": ""
      },
      "sources": [
        {
          "name": "",
          "url": ""
        }
      ]
    }
  ]
}
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

      return {
        name: cleanString(company.name),
        phone: cleanString(company.phone),
        email: cleanString(company.email),
        website: cleanString(company.website),
        address: cleanString(company.address),
        postal_code: cleanString(
          company.postal_code
        ),
        city: cleanString(company.city),
        country:
          cleanString(company.country) ||
          "Deutschland",
        industry: cleanString(company.industry),
        employees: toInteger(company.employees),
        description: cleanString(
          company.description
        ),
        reason: cleanString(company.reason),

        contact:
          company.contact &&
          typeof company.contact === "object"
            ? {
                first_name: cleanString(
                  company.contact.first_name
                ),
                last_name: cleanString(
                  company.contact.last_name
                ),
                job_title: cleanString(
                  company.contact.job_title
                ),
                email: cleanString(
                  company.contact.email
                ),
                phone: cleanString(
                  company.contact.phone
                ),
                mobile: cleanString(
                  company.contact.mobile
                ),
              }
            : null,

        sources: Array.isArray(company.sources)
          ? company.sources
              .filter((source) => source?.url)
              .map((source) => ({
                name: cleanString(source.name),
                url: cleanString(source.url),
              }))
              .slice(0, 10)
          : [],
      };
    })
    .filter((company) => company?.name);
}


/* ============================================================
   DUPLIKATE
   ============================================================ */

function removeDuplicates(
  companies,
  existingCompanies
) {
  const existingKeys = new Set(
    existingCompanies.map(createCompanyKey)
  );

  const seen = new Set();

  return companies.filter((company) => {
    const key = createCompanyKey(company);

    if (!key) return false;
    if (seen.has(key)) return false;
    if (existingKeys.has(key)) return false;

    seen.add(key);

    return true;
  });
}

function createCompanyKey(company) {
  const name = normalizeKey(company?.name);

  if (name) return name;

  return normalizeKey(company?.website);
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
   SUCHLAUF AKTUALISIEREN
   ============================================================ */

async function updateSearch(searchId, data) {
  if (!searchId) return;

  const result = await supabase
    .from("lead_searches")
    .update(data)
    .eq("id", searchId);

  if (result.error) {
    console.error(
      "Fehler beim Aktualisieren der Suche:",
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
  return Math.min(
    Math.max(value, min),
    max
  );
}