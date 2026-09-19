// api/company-import.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY;

function supabaseHeaders() {
    return {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
    };
}

async function getUser(req) {
    const auth =
        req.headers.authorization ||
        req.headers.Authorization;

    if (!auth?.startsWith("Bearer ")) {
        throw new Error("Nicht authentifiziert.");
    }

    const token = auth.replace("Bearer ", "");

    const response = await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${token}`
            }
        }
    );

    if (!response.ok) {
        throw new Error("Sitzung ungültig.");
    }

    return await response.json();
}

function clean(value) {
    return value
        ? String(value).trim()
        : null;
}

function normalizeKey(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]/g, "");
}

function getField(lines, names) {
    for (const line of lines) {
        const match = line.match(
            /^([^:]+):\s*(.+)$/i
        );

        if (!match) continue;

        const key = normalizeKey(match[1]);
        const value = match[2].trim();

        for (const name of names) {
            if (key === normalizeKey(name)) {
                return value;
            }
        }
    }

    return null;
}

function guessCompanyName(lines) {
    const first = lines[0] || "";

    if (
        !first.includes(":") &&
        first.length > 1
    ) {
        return first.trim();
    }

    return null;
}

function detectLegalForm(text) {
    const value = text.toLowerCase();

    if (/\be\.?k\.?\b/.test(value)) {
        return "e.K.";
    }

    if (value.includes("einzelunternehmen")) {
        return "Einzelunternehmen";
    }

    if (value.includes("gmbh & co")) {
        return "GmbH & Co. KG";
    }

    if (value.includes("gmbh")) {
        return "GmbH";
    }

    if (value.includes("ug")) {
        return "UG";
    }

    if (value.includes("ag")) {
        return "AG";
    }

    if (value.includes("ohg")) {
        return "OHG";
    }

    if (value.includes("kg")) {
        return "KG";
    }

    if (value.includes("gbr")) {
        return "GbR";
    }

    return null;
}

function splitCompanyBlocks(text) {
    return text
        .replace(/\r/g, "")
        .split(/\n\s*\n+/)
        .map(block =>
            block
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean)
        )
        .filter(block => block.length);
}

function parseCompany(block) {
    const joined = block.join(" ");

    const name =
        getField(block, [
            "name",
            "firma",
            "unternehmen",
            "firmenname"
        ]) ||
        guessCompanyName(block);

    if (!name) {
        return null;
    }

    const address =
        getField(block, [
            "adresse",
            "anschrift"
        ]);

    const postalCode =
        getField(block, [
            "plz",
            "postleitzahl"
        ]);

    const city =
        getField(block, [
            "ort",
            "stadt"
        ]);

    const phone =
        getField(block, [
            "telefon",
            "tel",
            "phone",
            "telefonnummer"
        ]);

    const website =
        getField(block, [
            "website",
            "webseite",
            "homepage",
            "url"
        ]);

    const industry =
        getField(block, [
            "branche",
            "branchen",
            "industrie",
            "kategorie"
        ]);

    const employees =
        getField(block, [
            "mitarbeiter",
            "mitarbeiterzahl",
            "employees"
        ]);

    const legalForm =
        getField(block, [
            "rechtsform",
            "unternehmensform",
            "firmenform"
        ]) ||
        detectLegalForm(joined);

    const description =
        getField(block, [
            "beschreibung",
            "description",
            "info"
        ]);

    return {
        name: clean(name),
        legal_name: clean(name),
        address: clean(address),
        postal_code: clean(postalCode),
        city: clean(city),
        phone: clean(phone),
        website: clean(website),
        industry: clean(industry),
        employees: employees
            ? Number(
                String(employees)
                    .replace(/\./g, "")
                    .replace(",", ".")
                    .match(/\d+(?:\.\d+)?/)?.[0]
              ) || null
            : null,
        legal_form: clean(legalForm),
        description: clean(description)
    };
}

function sameCompany(a, b) {
    const nameA =
        String(a.name || "")
            .toLowerCase()
            .replace(/[^a-z0-9äöüß]/g, "");

    const nameB =
        String(b.name || "")
            .toLowerCase()
            .replace(/[^a-z0-9äöüß]/g, "");

    if (
        nameA &&
        nameB &&
        nameA === nameB
    ) {
        return true;
    }

    if (
        a.phone &&
        b.phone &&
        a.phone.replace(/\D/g, "") ===
            b.phone.replace(/\D/g, "")
    ) {
        return true;
    }

    if (
        a.website &&
        b.website &&
        a.website.toLowerCase() ===
            b.website.toLowerCase()
    ) {
        return true;
    }

    return false;
}

async function findExisting(userId, company) {
    const response = await fetch(
        `${SUPABASE_URL}/rest/v1/companies?user_id=eq.${encodeURIComponent(
            userId
        )}&select=*`,
        {
            headers: supabaseHeaders()
        }
    );

    if (!response.ok) {
        throw new Error(
            "Bestehende Unternehmen konnten nicht geladen werden."
        );
    }

    const companies = await response.json();

    return companies.find(existing =>
        sameCompany(existing, company)
    );
}

async function insertCompany(userId, company) {
    const response = await fetch(
        `${SUPABASE_URL}/rest/v1/companies`,
        {
            method: "POST",
            headers: {
                ...supabaseHeaders(),
                Prefer: "return=representation"
            },
            body: JSON.stringify({
                user_id: userId,
                ...company
            })
        }
    );

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            text ||
            "Unternehmen konnte nicht gespeichert werden."
        );
    }

    const rows = JSON.parse(text);

    return rows[0];
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method Not Allowed"
        });
    }

    try {
        const user = await getUser(req);

        const body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body || {};

        const text = String(
            body.text || ""
        ).trim();

        if (!text) {
            return res.status(400).json({
                error:
                    "Keine Unternehmensdaten übergeben."
            });
        }

        const blocks =
            splitCompanyBlocks(text);

        let imported = 0;
        let duplicates = 0;
        let invalid = 0;

        for (const block of blocks) {
            const company =
                parseCompany(block);

            if (!company?.name) {
                invalid++;
                continue;
            }

            const existing =
                await findExisting(
                    user.id,
                    company
                );

            if (existing) {
                duplicates++;
                continue;
            }

            await insertCompany(
                user.id,
                company
            );

            imported++;
        }

        return res.status(200).json({
            success: true,
            imported,
            duplicates,
            invalid,
            total_blocks: blocks.length
        });

    } catch (error) {
        console.error(
            "Company import error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Unternehmen konnten nicht importiert werden."
        });
    }
}
