import { supabase } from "./supabase.js";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL fehlt.");
}

if (!supabaseAnonKey) {
  throw new Error("SUPABASE_ANON_KEY fehlt.");
}

const supabaseAuth = createClient(
  supabaseUrl,
  supabaseAnonKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

async function authenticate(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.substring(7).trim();

  if (!token) {
    return null;
  }

  const { data, error } = await supabaseAuth.auth.getUser(token);

  if (error || !data?.user) {
    return null;
  }

  return data.user;
}

function normalizeCompanyName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeWebsite(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function companyKey(company) {
  const name = normalizeCompanyName(company.company_name);
  const website = normalizeWebsite(company.website);

  return `${name}|${website}`;
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();

  return text || null;
}

function cleanInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(number);
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

function extractJson(text) {
  if (!text) {
    throw new Error("Gemini hat keine Antwort geliefert.");
  }

  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(
        cleaned.slice(firstBrace, lastBrace + 1)
      );
    }

    throw new Error("Gemini-Antwort konnte nicht als JSON gelesen werden.");
  }
}

function getGeminiText(response) {
  const candidate = response?.candidates?.[0];

  if (!candidate?.content?.parts) {
    return "";
  }

  return candidate.content.parts
    .map((part) => part?.text || "")
    .join("")
    .trim();
}

function getGroundingSources(response) {
  const chunks =
    response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  return chunks
    .map((chunk) => {
      const web = chunk?.web;

      if (!web?.uri) {
        return null;
      }

      return {
        url: web.uri,
        name: web.title || web.uri
      };
    })
    .filter(Boolean);
}

function buildPrompt({
  industry,
  postal,
  radiusKm,
  employeesFrom,
  employeesTo,
  amount,
  additionalCriteria,
  exclusionCriteria,
  existingCompanies
}) {
  const existingList = existingCompanies.length
    ? existingCompanies
        .slice(0, 500)
        .map((company) => {
          return `- ${company.legal_name || company.name || ""} | ${
            company.website || ""
          }`;
        })
        .join("\n")
    : "Keine bestehenden Unternehmen vorhanden.";

  return `
Du bist ein professioneller B2B-Lead-Recherche-Agent für ein deutsches CRM.

DEINE AUFGABE:
Finde reale B2B-Unternehmen, die exakt zu den Suchkriterien passen.

SUCHKRITERIEN:
Branche:
${industry}

PLZ / Region:
${postal}

Radius:
${radiusKm} km

Mitarbeiter von:
${employeesFrom ?? "keine Angabe"}

Mitarbeiter bis:
${employeesTo ?? "keine Angabe"}

Gewünschte Anzahl:
${amount}

Zusätzliche Kriterien:
${additionalCriteria || "Keine"}

Ausschlusskriterien:
${exclusionCriteria || "Keine"}

WICHTIGE REGELN:

1. Suche ausschließlich nach real existierenden Unternehmen.
2. Verwende Google Search zur Recherche.
3. Erfinde niemals Unternehmen, Telefonnummern, Websites, E-Mail-Adressen oder Mitarbeiterzahlen.
4. Wenn eine Information nicht verlässlich gefunden werden kann, setze sie auf null.
5. Bevorzuge offizielle Unternehmenswebsites und seriöse Unternehmensquellen.
6. Unternehmen müssen zur angegebenen Branche passen.
7. Unternehmen müssen geografisch zur angegebenen Region passen.
8. Berücksichtige den gewünschten Mitarbeiterbereich.
9. Beachte alle zusätzlichen Kriterien.
10. Beachte alle Ausschlusskriterien.
11. Liefere keine Duplikate.
12. Liefere keine Unternehmen aus der bereits vorhandenen Liste.
13. Eine Mitarbeiterzahl darf nur eingetragen werden, wenn sie aus einer verlässlichen Quelle hervorgeht.
14. Telefonnummern dürfen nicht erfunden oder geraten werden.
15. E-Mail-Adressen dürfen nicht erfunden oder geraten werden.
16. Persönliche Kontaktdaten nur dann liefern, wenn sie öffentlich und eindeutig als geschäftliche Kontaktdaten veröffentlicht sind.
17. Wenn die Entfernung nicht zuverlässig bestimmbar ist, setze distance_km auf null.
18. source_url muss möglichst die wichtigste gefundene Quelle für das Unternehmen sein.
19. company_name muss der tatsächlich verwendete Unternehmensname sein.
20. legal_name nur ausfüllen, wenn die offizielle Firmierung eindeutig gefunden wurde.
21. Keine Fantasie-Daten.
22. Qualität ist wichtiger als eine künstlich erreichte Anzahl.

BEREITS VORHANDENE UNTERNEHMEN:
${existingList}

Gib ausschließlich ein JSON-Objekt nach folgendem Schema zurück:

{
  "leads": [
    {
      "company_name": "string",
      "legal_name": "string|null",
      "industry": "string|null",
      "website": "string|null",
      "phone": "string|null",
      "email": "string|null",
      "address": "string|null",
      "postal_code": "string|null",
      "city": "string|null",
      "country": "string|null",
      "employee_count": "integer|null",
      "distance_km": "number|null",
      "description": "string|null",
      "source_url": "string|null",
      "source_name": "string|null"
    }
  ]
}
`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const user = await authenticate(req);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Nicht authentifiziert."
    });
  }

  let searchId = null;

  try {
    const body = req.body || {};

    const industry = cleanValue(body.industry);
    const postal = cleanValue(body.postal);

    const radiusKm = Math.max(
      1,
      Math.min(
        250,
        Number(body.radius_km || 25)
      )
    );

    const amount = Math.max(
      1,
      Math.min(
        100,
        Number(body.anzahl || 50)
      )
    );

    const employeesFrom =
      body.mitarbeiter_von === "" ||
      body.mitarbeiter_von === undefined
        ? null
        : cleanInteger(body.mitarbeiter_von);

    const employeesTo =
      body.mitarbeiter_bis === "" ||
      body.mitarbeiter_bis === undefined
        ? null
        : cleanInteger(body.mitarbeiter_bis);

    const additionalCriteria =
      cleanValue(body.zusatzkriterien) || "";

    const exclusionCriteria =
      cleanValue(body.ausschlusskriterien) || "";

    if (!industry) {
      return res.status(400).json({
        success: false,
        error: "Branche fehlt."
      });
    }

    if (!postal) {
      return res.status(400).json({
        success: false,
        error: "PLZ fehlt."
      });
    }

    if (
      employeesFrom !== null &&
      employeesTo !== null &&
      employeesFrom > employeesTo
    ) {
      return res.status(400).json({
        success: false,
        error: "Mitarbeiter-von darf nicht größer als Mitarbeiter-bis sein."
      });
    }

    const { data: search, error: searchInsertError } =
      await supabase
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
          additional_criteria: additionalCriteria,
          exclusion_criteria: exclusionCriteria
        })
        .select()
        .single();

    if (searchInsertError) {
      throw new Error(
        `Lead-Suche konnte nicht gespeichert werden: ${searchInsertError.message}`
      );
    }

    searchId = search.id;

    const { data: existingCompanies, error: existingError } =
      await supabase
        .from("companies")
        .select("legal_name,website,name");

    if (existingError) {
      throw new Error(
        `Bestehende Unternehmen konnten nicht geladen werden: ${existingError.message}`
      );
    }

    const existing = existingCompanies || [];

    const prompt = buildPrompt({
      industry,
      postal,
      radiusKm,
      employeesFrom,
      employeesTo,
      amount,
      additionalCriteria,
      exclusionCriteria,
      existingCompanies: existing
    });

    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      throw new Error("GEMINI_API_KEY fehlt in den Vercel Environment Variables.");
    }

    const model =
      process.env.GEMINI_MODEL || "gemini-3.8-flash";

    const schema = {
      type: "OBJECT",
      properties: {
        leads: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              company_name: { type: "STRING" },
              legal_name: { type: "STRING", nullable: true },
              industry: { type: "STRING", nullable: true },
              website: { type: "STRING", nullable: true },
              phone: { type: "STRING", nullable: true },
              email: { type: "STRING", nullable: true },
              address: { type: "STRING", nullable: true },
              postal_code: { type: "STRING", nullable: true },
              city: { type: "STRING", nullable: true },
              country: { type: "STRING", nullable: true },
              employee_count: { type: "INTEGER", nullable: true },
              distance_km: { type: "NUMBER", nullable: true },
              description: { type: "STRING", nullable: true },
              source_url: { type: "STRING", nullable: true },
              source_name: { type: "STRING", nullable: true }
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
      required: ["leads"]
    };

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent`;

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "Du bist ein extrem sorgfältiger B2B-Recherche-Agent. " +
                "Arbeite faktenbasiert, nutze Websuche und erfinde niemals Daten."
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        tools: [
          {
            googleSearch: {}
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      })
    });

    const geminiRaw = await geminiResponse.text();

    if (!geminiResponse.ok) {
      throw new Error(
        `Gemini API Fehler (${geminiResponse.status}): ${geminiRaw}`
      );
    }

    let geminiJson;

    try {
      geminiJson = JSON.parse(geminiRaw);
    } catch {
      throw new Error("Gemini API hat keine gültige JSON-Antwort geliefert.");
    }

    const text = getGeminiText(geminiJson);

    const parsed = extractJson(text);

    const rawLeads = Array.isArray(parsed?.leads)
      ? parsed.leads
      : [];

    const groundingSources =
      getGroundingSources(geminiJson);

    const existingKeys = new Set(
      existing.map((company) => {
        return companyKey({
          company_name:
            company.legal_name || company.name || "",
          website: company.website || ""
        });
      })
    );

    const seenKeys = new Set(existingKeys);
    const uniqueLeads = [];

    for (const rawLead of rawLeads) {
      const lead = {
        company_name: cleanValue(rawLead.company_name),
        legal_name: cleanValue(rawLead.legal_name),
        industry: cleanValue(rawLead.industry),
        website: cleanValue(rawLead.website),
        phone: cleanValue(rawLead.phone),
        email: cleanValue(rawLead.email),
        address: cleanValue(rawLead.address),
        postal_code: cleanValue(rawLead.postal_code),
        city: cleanValue(rawLead.city),
        country: cleanValue(rawLead.country),
        employee_count: cleanInteger(rawLead.employee_count),
        distance_km: cleanNumber(rawLead.distance_km),
        description: cleanValue(rawLead.description),
        source_url: cleanValue(rawLead.source_url),
        source_name: cleanValue(rawLead.source_name)
      };

      if (!lead.company_name) {
        continue;
      }

      const key = companyKey(lead);

      if (seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      uniqueLeads.push(lead);

      if (uniqueLeads.length >= amount) {
        break;
      }
    }

    const savedLeads = [];

    for (const lead of uniqueLeads) {
      const { data: company, error: companyError } =
        await supabase
          .from("companies")
          .insert({
            user_id: user.id,
            legal_name: lead.legal_name || lead.company_name,
            industry: lead.industry || industry,
            website: lead.website,
            phone: lead.phone,
            email: lead.email,
            address: lead.address,
            postal_code: lead.postal_code,
            city: lead.city,
            country: lead.country || "Deutschland",
            employee_count: lead.employee_count
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

      const { data: createdLead, error: leadError } =
        await supabase
          .from("leads")
          .insert({
            user_id: user.id,
            company_id: company.id,
            status: "new",
            priority: "normal",
            score: null,
            notes: lead.description,
            assigned_to: user.id
          })
          .select()
          .single();

      if (leadError) {
        console.error(
          "Lead insert error:",
          leadError
        );

        await supabase
          .from("companies")
          .delete()
          .eq("id", company.id)
          .eq("user_id", user.id);

        continue;
      }

      if (lead.source_url || groundingSources.length) {
        const sourceUrl =
          lead.source_url ||
          groundingSources[0]?.url ||
          null;

        const sourceName =
          lead.source_name ||
          groundingSources[0]?.name ||
          "Google Search";

        if (sourceUrl) {
          await supabase
            .from("lead_sources")
            .insert({
              user_id: user.id,
              lead_id: createdLead.id,
              company_id: company.id,
              source_type: "web",
              source_name: sourceName,
              source_url: sourceUrl,
              metadata: {
                distance_km: lead.distance_km,
                grounding_sources: groundingSources
              }
            });
        }
      }

      await supabase
        .from("activities")
        .insert({
          user_id: user.id,
          lead_id: createdLead.id,
          company_id: company.id,
          type: "lead_created",
          subject: "Lead durch Gemini KI-Recherche erstellt",
          description:
            lead.description ||
            "Lead wurde automatisch durch die KI-Recherche gefunden."
        });

      savedLeads.push({
        ...lead,
        id: createdLead.id,
        company_id: company.id
      });
    }

    await supabase
      .from("lead_searches")
      .update({
        status: "completed",
        results_count: savedLeads.length,
        completed_at: new Date().toISOString()
      })
      .eq("id", searchId)
      .eq("user_id", user.id);

    return res.status(200).json({
      success: true,
      search_id: searchId,
      requested: amount,
      found: uniqueLeads.length,
      saved: savedLeads.length,
      leads: savedLeads
    });

  } catch (error) {
    console.error("lead-search error:", error);

    if (searchId) {
      await supabase
        .from("lead_searches")
        .update({
          status: "failed",
          error_message: error.message,
          completed_at: new Date().toISOString()
        })
        .eq("id", searchId)
        .eq("user_id", user.id);
    }

    return res.status(500).json({
      success: false,
      error: error.message || "Lead-Suche fehlgeschlagen."
    });
  }
}