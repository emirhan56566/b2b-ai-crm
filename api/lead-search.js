// api/lead-search.js

import { supabase } from "./supabase.js";

async function authenticate(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return { user: null, error: "Nicht authentifiziert." };
  }

  const token = authorization.substring(7).trim();

  if (!token) {
    return { user: null, error: "Kein Access Token vorhanden." };
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    return {
      user: null,
      error: "Ungültige oder abgelaufene Sitzung."
    };
  }

  const user = await response.json();

  if (!user?.id) {
    return {
      user: null,
      error: "Benutzer konnte nicht ermittelt werden."
    };
  }

  return { user, error: null };
}

function parseBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeCompanyName(name) {
  return cleanText(name)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,/\\'"`´]/g, "")
    .trim();
}

async function callGemini(prompt, model) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY fehlt.");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
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
          google_search: {}
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

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
      raw ||
      `Gemini Fehler ${response.status}`
    );
  }

  return data;
}

function extractGeminiText(data) {
  const candidates = data?.candidates || [];

  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];

    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return "";
}

function parseJson(text) {
  if (!text) {
    throw new Error("Gemini hat keine verwertbare Antwort geliefert.");
  }

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(fenced);
  } catch {}

  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");

  if (first !== -1 && last > first) {
    try {
      return JSON.parse(fenced.slice(first, last + 1));
    } catch {}
  }

  const firstArray = fenced.indexOf("[");
  const lastArray = fenced.lastIndexOf("]");

  if (firstArray !== -1 && lastArray > firstArray) {
    try {
      return JSON.parse(
        fenced.slice(firstArray, lastArray + 1)
      );
    } catch {}
  }

  throw new Error("Gemini-Antwort konnte nicht als JSON gelesen werden.");
}

function normalizeLead(raw) {
  if (!raw || typeof raw !== "object") return null;

  const company = raw.company || raw.company_data || raw;

  const name = cleanText(
    company.name ||
    company.company_name ||
    company.firm_name
  );

  if (!name) return null;

  return {
    name,
    legal_name: cleanText(company.legal_name) || null,
    industry: cleanText(company.industry) || null,
    website: cleanText(company.website) || null,
    phone: cleanText(company.phone) || null,
    email: cleanText(company.email) || null,
    address: cleanText(company.address) || null,
    postal_code: cleanText(
      company.postal_code ||
      company.zip ||
      company.plz
    ) || null,
    city: cleanText(company.city) || null,
    country: cleanText(company.country) || "Deutschland",
    employee_count:
      Number.isFinite(Number(company.employee_count))
        ? Number(company.employee_count)
        : null,

    contact: raw.contact || null,

    source_url: cleanText(
      raw.source_url ||
      raw.source ||
      company.source_url
    ) || null,

    source_title: cleanText(
      raw.source_title ||
      company.source_title
    ) || null,

    reason: cleanText(
      raw.reason ||
      raw.qualification_reason ||
      raw.match_reason
    ) || null
  };
}

function buildPrompt(input) {
  const branche = cleanText(input.branche);
  const plz = cleanText(input.plz);
  const radius = cleanText(input.radius_km);
  const mitarbeiterVon = cleanText(input.mitarbeiter_von);
  const mitarbeiterBis = cleanText(input.mitarbeiter_bis);
  const anzahl = Number(input.anzahl) || 50;
  const zusatz = cleanText(input.zusatzkriterien);
  const ausschluss = cleanText(input.ausschlusskriterien);

  return `
Du bist ein B2B-Lead-Recherche-System.

Finde reale Unternehmen in Deutschland, die zu den folgenden Suchkriterien passen.

SUCHKRITERIEN:
Branche: ${branche || "keine Angabe"}
PLZ / Standort: ${plz || "keine Angabe"}
Radius: ${radius ? `${radius} km` : "keine Angabe"}
Mitarbeiter von: ${mitarbeiterVon || "keine Angabe"}
Mitarbeiter bis: ${mitarbeiterBis || "keine Angabe"}
Gewünschte Anzahl: ${anzahl}
Zusatzkriterien: ${zusatz || "keine"}
Ausschlusskriterien: ${ausschluss || "keine"}

RECHERCHE:
- Nutze Websuche, um reale Unternehmen zu finden.
- Erfinde niemals Unternehmen.
- Verwende nur Unternehmen, die anhand öffentlich verfügbarer Informationen nachvollziehbar sind.
- Prüfe möglichst mehrere Informationen pro Unternehmen.
- Bevorzuge offizielle Unternehmenswebsites und andere seriöse Quellen.
- Keine Privatpersonen als Unternehmen ausgeben.
- Keine erfundenen Telefonnummern, E-Mail-Adressen, Websites oder Mitarbeiterzahlen.
- Wenn eine Information nicht verlässlich gefunden werden kann, setze sie auf null.
- Unternehmen dürfen nicht doppelt ausgegeben werden.
- Beachte die Ausschlusskriterien strikt.
- Wenn die exakte gewünschte Anzahl nicht seriös gefunden werden kann, gib weniger Ergebnisse zurück.
- Gib keine Erklärung außerhalb des JSON zurück.

AUSGABE:
Antworte ausschließlich mit gültigem JSON im folgenden Format:

{
  "companies": [
    {
      "name": "Firmenname",
      "legal_name": null,
      "industry": null,
      "website": null,
      "phone": null,
      "email": null,
      "address": null,
      "postal_code": null,
      "city": null,
      "country": "Deutschland",
      "employee_count": null,
      "source_url": null,
      "source_title": null,
      "reason": null
    }
  ]
}

Die Anzahl der Unternehmen soll maximal ${anzahl} betragen.
  `.trim();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        error: "Nur POST erlaubt."
      });
    }

    const { user, error: authError } =
      await authenticate(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: authError || "Nicht authentifiziert."
      });
    }

    const body = parseBody(req);

    const anzahl = Math.min(
      Math.max(Number(body.anzahl) || 50, 1),
      100
    );

    const searchInput = {
      branche: body.branche,
      plz: body.plz,
      radius_km: body.radius_km,
      mitarbeiter_von: body.mitarbeiter_von,
      mitarbeiter_bis: body.mitarbeiter_bis,
      anzahl,
      zusatzkriterien: body.zusatzkriterien,
      ausschlusskriterien: body.ausschlusskriterien
    };

    const prompt = buildPrompt(searchInput);

    const model =
      process.env.GEMINI_MODEL ||
      "gemini-2.5-flash";

    const { data: searchRecord, error: searchInsertError } =
      await supabase
        .from("lead_searches")
        .insert({
          user_id: user.id,
          query: JSON.stringify(searchInput),
          status: "running"
        });

    if (searchInsertError) {
      console.error(
        "lead_searches INSERT:",
        searchInsertError
      );
    }

    const geminiResponse = await callGemini(
      prompt,
      model
    );

    const text = extractGeminiText(geminiResponse);
    const parsed = parseJson(text);

    const rawCompanies = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.companies)
        ? parsed.companies
        : [];

    const normalizedCompanies =
      rawCompanies
        .map(normalizeLead)
        .filter(Boolean);

    /*
     * Bestehende Unternehmen dieses Benutzers laden.
     * Wichtig: user_id verhindert Cross-User-Datenzugriff.
     */
    const {
      data: existingCompanies,
      error: existingError
    } = await supabase
      .from("companies")
      .select(`
        id,
        name,
        legal_name,
        website,
        phone,
        postal_code,
        city
      `)
      .eq("user_id", user.id)
      .limit(1000);

    if (existingError) {
      throw new Error(
        `Bestehende Unternehmen konnten nicht geladen werden: ${existingError.message}`
      );
    }

    const existingNames = new Set(
      (existingCompanies || [])
        .map((company) =>
          normalizeCompanyName(company.name)
        )
        .filter(Boolean)
    );

    const newCompanies = [];
    const skippedDuplicates = [];

    for (const company of normalizedCompanies) {
      const normalizedName =
        normalizeCompanyName(company.name);

      if (!normalizedName) continue;

      if (existingNames.has(normalizedName)) {
        skippedDuplicates.push(company.name);
        continue;
      }

      if (
        newCompanies.some(
          (item) =>
            normalizeCompanyName(item.name) ===
            normalizedName
        )
      ) {
        skippedDuplicates.push(company.name);
        continue;
      }

      newCompanies.push(company);

      if (newCompanies.length >= anzahl) {
        break;
      }
    }

    const createdLeads = [];

    for (const company of newCompanies) {
      const {
        data: insertedCompany,
        error: companyError
      } = await supabase
        .from("companies")
        .insert({
          user_id: user.id,
          name: company.name,
          legal_name: company.legal_name,
          industry: company.industry,
          website: company.website,
          phone: company.phone,
          email: company.email,
          address: company.address,
          postal_code: company.postal_code,
          city: company.city,
          country: company.country,
          employee_count: company.employee_count
        })
        .single();

      if (companyError) {
        console.error(
          "Company INSERT:",
          companyError
        );
        continue;
      }

      let contactId = null;

      if (company.contact) {
        const contact = company.contact;

        const {
          data: insertedContact,
          error: contactError
        } = await supabase
          .from("contacts")
          .insert({
            user_id: user.id,
            company_id: insertedCompany.id,
            first_name:
              cleanText(contact.first_name) || null,
            last_name:
              cleanText(contact.last_name) || null,
            job_title:
              cleanText(contact.job_title) || null,
            email:
              cleanText(contact.email) || null,
            phone:
              cleanText(contact.phone) || null,
            mobile:
              cleanText(contact.mobile) || null,
            linkedin_url:
              cleanText(contact.linkedin_url) || null
          })
          .single();

        if (!contactError) {
          contactId = insertedContact?.id || null;
        }
      }

      const {
        data: insertedLead,
        error: leadError
      } = await supabase
        .from("leads")
        .insert({
          user_id: user.id,
          company_id: insertedCompany.id,
          contact_id: contactId,
          status: "new",
          priority: "medium",
          score: null,
          notes: company.reason || null,
          assigned_to: user.id
        })
        .single();

      if (leadError) {
        console.error(
          "Lead INSERT:",
          leadError
        );
        continue;
      }

      if (company.source_url) {
        await supabase
          .from("lead_sources")
          .insert({
            user_id: user.id,
            lead_id: insertedLead.id,
            source_url: company.source_url,
            source_title:
              company.source_title || null
          });
      }

      await supabase
        .from("activities")
        .insert({
          user_id: user.id,
          lead_id: insertedLead.id,
          company_id: insertedCompany.id,
          type: "lead_created",
          subject: "Lead durch KI-Recherche erstellt",
          description:
            company.reason ||
            "Lead wurde durch die KI-Leadsuche gefunden."
        });

      createdLeads.push({
        lead_id: insertedLead.id,
        company_id: insertedCompany.id,
        company_name: company.name,
        city: company.city,
        postal_code: company.postal_code,
        phone: company.phone,
        website: company.website,
        employee_count: company.employee_count,
        source_url: company.source_url
      });
    }

    if (searchRecord?.id) {
      await supabase
        .from("lead_searches")
        .update({
          status: "completed",
          results_count: createdLeads.length,
          completed_at: new Date().toISOString()
        })
        .eq("id", searchRecord.id)
        .eq("user_id", user.id);
    }

    return res.status(200).json({
      success: true,
      count: createdLeads.length,
      leads: createdLeads,
      skipped_duplicates: skippedDuplicates.length
    });

  } catch (error) {
    console.error("lead-search error:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Fehler bei der KI-Leadsuche."
    });
  }
}